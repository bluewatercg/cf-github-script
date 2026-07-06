export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.host; // 当前 Worker 的域名

    // ================= 1. 从路径中提取目标 URL =================
    // 支持三种格式：
    //   /https://example.com/path   → https://example.com/path
    //   /http://example.com/path    → http://example.com/path
    //   /example.com/path           → https://example.com/path（默认补 https）
    // 注：URL 中双斜杠 // 在 pathname 中会被压缩为单斜杠 /，
    // 因此 https://example.com 入站后 pathname 为 /https:/example.com
    let rawPath = url.pathname.slice(1); // 去掉开头的 /

    let targetUrlStr;
    if (/^https?:\/[^/]/.test(rawPath)) {
      // 匹配 https:/x 或 http:/x，还原被压缩的双斜杠
      targetUrlStr = rawPath.replace(/^(https?):\//, '$1://');
    } else if (rawPath.includes('://')) {
      // 兜底：如果 pathname 意外保留了完整协议
      targetUrlStr = rawPath;
    } else if (rawPath === '') {
      return new Response('请指定目标地址，例如: https://worker域名/https://example.com', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    } else {
      // 没有协议，默认补 https
      targetUrlStr = 'https://' + rawPath;
    }

    const targetUrl = new URL(targetUrlStr + url.search);
    // 代理路径前缀，用作后续 URL 重写（例如 /https:/example.com）
    const proxyPath = '/' + targetUrlStr;
    // ============================================================

    // ================= 2. 复制并清洗请求头 =================
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", targetUrl.host);
    newHeaders.set("Referer", targetUrl.origin);
    newHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    newHeaders.delete("cf-connecting-ip");
    newHeaders.delete("cf-ipcountry");
    newHeaders.delete("cf-ray");
    newHeaders.delete("cf-visitor");
    // ============================================================

    // ================= 3. 【新增】WebSocket 代理 =================
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return handleWebSocket(targetUrl);
    }
    // ============================================================

    // ================= 4. 发起对目标网站的 HTTP 请求 =================
    try {
      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        // 【优化】GET/HEAD 请求不携带 body，避免兼容性问题
        body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        redirect: "manual" // 手动处理重定向
      });

      // ================= 5. 处理响应头 =================
      let modifiedHeaders = new Headers();

      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();

        // 【优化】移除 Content-Security-Policy，防止原站 CSP 限制代理后的资源加载
        if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
          continue;
        }

        // 【优化】移除 Strict-Transport-Security，防止其作用于 Worker 域名
        if (lowerKey === 'strict-transport-security') {
          continue;
        }

        // 【优化】重写 Set-Cookie 中的 Domain 属性
        // 原站 Domain=.example.com 的 Cookie 会被浏览器拒绝，因为当前域名是 Worker 域名
        // 策略：移除 Domain 属性，让浏览器自动将 Cookie 作用域限制在当前 Worker 域名下
        if (lowerKey === 'set-cookie') {
          const newValue = value.replace(/;\s*domain\s*=\s*[^;]+\s*/gi, '');
          modifiedHeaders.append(key, newValue);
          continue;
        }

        modifiedHeaders.append(key, value);
      }
      // =================================================

      // ================= 6. 重定向拦截 =================
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let location = modifiedHeaders.get("Location");
        if (location) {
          // 如果重定向包含目标域名，替换为当前 Worker 域名
          if (location.includes(targetUrl.host)) {
            location = location.replace(targetUrl.host, workerDomain);
            location = location.replace(/^http:/, "https:");
          }
          modifiedHeaders.set("Location", location);
        }
      }
      // =================================================

      // ================= 7. 注入 CORS 头 =================
      modifiedHeaders.set("Access-Control-Allow-Origin", "*");
      modifiedHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      modifiedHeaders.set("Access-Control-Allow-Headers", "*");

      // 【优化】添加 Vary: Origin 头，配合 CORS 防止缓存污染
      if (modifiedHeaders.has("Vary")) {
        const vary = modifiedHeaders.get("Vary");
        if (!vary.split(',').map(v => v.trim()).includes('Origin')) {
          modifiedHeaders.set("Vary", vary + ", Origin");
        }
      } else {
        modifiedHeaders.set("Vary", "Origin");
      }
      // =================================================

      // OPTIONS 预检请求直接返回
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: modifiedHeaders
        });
      }

      // ================= 8. 【优化】HTML 响应中的链接重写 =================
      // 将响应体中所有指向原站的 URL 替换为代理路径
      // 让用户点击页面内的链接、加载图片/脚本等资源时仍然经过 Worker
      const contentType = modifiedHeaders.get("Content-Type") || '';

      if (contentType.includes('text/html')) {
        const text = await response.text();

        // 转义目标源的正则特殊字符
        const escapedOrigin = targetUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // 分两步重写：
        //   a) 绝对 URL：将 href/src/action 中的 https://example.com 替换为代理前缀
        //   b) 根相对路径：将 href/src/action 中的 /path 替换为 /https:/example.com/path
        const rewrittenText = text
          // a) 重写绝对 URL（href、src、action、srcset、formaction）
          .replace(
            new RegExp(`((?:href|src|action|srcset|formaction)=["'])${escapedOrigin}`, 'gi'),
            `$1${proxyPath}`
          )
          // 也处理 inline CSS 中的 url(https://example.com/...)
          .replace(
            new RegExp(`(url\\(["']?)${escapedOrigin}`, 'gi'),
            `$1${proxyPath}`
          )
          // b) 重写根相对路径（/path → /https:/example.com/path）
          // 仅针对 HTML 标签中常见的资源属性
          .replace(
            /(<(?:a|base|form|img|link|script|video|audio|source|iframe|embed|area)[^>]*\s(?:href|src|action)=["'])\//gi,
            `$1${proxyPath}/`
          )
          // c) 重写 <base> 标签的 href，防止其干扰 URL 解析
          .replace(
            new RegExp(`(<base[^>]*\\shref=["'])${escapedOrigin}`, 'gi'),
            `$1${proxyPath}`
          );

        return new Response(rewrittenText, {
          status: response.status,
          statusText: response.statusText,
          headers: modifiedHeaders
        });
      }
      // ============================================================

      // 非 HTML 响应直接透传
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: modifiedHeaders
      });

    } catch (err) {
      return new Response(`反向代理发生错误: ${err.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }
};

// ================= WebSocket 代理处理函数 =================
// 将客户端的 WebSocket 连接透明地转发到目标服务器
async function handleWebSocket(targetUrl) {
  // 将目标 URL 从 http(s) 协议转换为 ws(s) 协议
  // https://example.com/path → wss://example.com/path
  const targetWsUrl = targetUrl.toString().replace(/^http/, 'ws');

  // 通过 fetch 发起 WebSocket 升级请求
  const wsResponse = await fetch(targetWsUrl);

  // 如果目标服务器成功升级为 WebSocket 连接
  if (wsResponse.status === 101 && wsResponse.webSocket) {
    // 接受 WebSocket 连接，开始消息转发
    wsResponse.webSocket.accept();

    // 返回 101 响应，将目标 WebSocket 与客户端自动配对
    // Workers 运行时会自动在客户端和目标之间转发消息
    return new Response(null, {
      status: 101,
      webSocket: wsResponse.webSocket,
    });
  }

  // 如果目标服务器未升级（可能返回 4xx 或其他），透传原始响应
  return wsResponse;
}
