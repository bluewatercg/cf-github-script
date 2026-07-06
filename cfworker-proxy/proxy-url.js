// ================= 配置区域 =================

// 屏蔽的国家/地区代码（ISO 3166-1 alpha-2），空数组表示不屏蔽
// 例如：["KP", "SY", "PK", "CU"]
const blocked_region = [];

// 屏蔽的 IP 地址，空数组表示不屏蔽
const blocked_ip_address = [];

// 自定义文本替换规则（在 HTML 中额外替换指定文本）
// 支持占位符：
//   $upstream      = 目标域名（如 example.com）
//   $custom_domain = 当前 Worker 域名
// 例如：{ "$upstream": "$custom_domain", "旧文本": "新文本" }
const replace_dict = {};

// 动态请求头规则：按域名配置对请求头的处理方式
//   "KEEP"   = 保留原始值（不覆盖）
//   "DELETE" = 删除该请求头
//   其他字符串 = 设置为该值
//   "*"      = 通配规则，所有域名均生效（优先级低于具体域名规则）
const specialCases = {
  // 示例：对所有域名生效
  // "*": {
  //   "Origin": "DELETE",
  //   "Referer": "DELETE",
  // },
  // 示例：仅对 example.com 生效
  // "example.com": {
  //   "X-Custom-Header": "my-value",
  // },
};
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.host;

    // ================= 1. 区域 / IP 屏蔽检查 =================
    const region = request.headers.get("cf-ipcountry") || "";
    const ipAddress = request.headers.get("cf-connecting-ip") || "";

    if (blocked_region.length > 0 && blocked_region.includes(region.toUpperCase())) {
      return new Response("Access denied: This service is not available in your region.", {
        status: 403,
      });
    }

    if (blocked_ip_address.length > 0 && blocked_ip_address.includes(ipAddress)) {
      return new Response("Access denied: Your IP address is blocked.", {
        status: 403,
      });
    }
    // ==========================================================

    // ================= 2. 根路径 → 着陆页 =================
    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>反向代理服务</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; color: #333; min-height: 100vh; display: flex; flex-direction: column; }
    header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: #fff; padding: 40px 20px; text-align: center; }
    header h1 { font-size: 2em; margin-bottom: 8px; }
    header p { opacity: 0.85; font-size: 1.1em; }
    .container { max-width: 800px; margin: 0 auto; padding: 30px 20px; flex: 1; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 20px; }
    .card h2 { font-size: 1.3em; margin-bottom: 12px; color: #1a1a2e; }
    code { background: #e8ecf1; padding: 3px 8px; border-radius: 4px; font-size: 0.9em; word-break: break-all; }
    .example { background: #f7f8fa; border-left: 4px solid #4a6cf7; padding: 16px; border-radius: 0 8px 8px 0; margin: 12px 0; }
    .example code { display: block; margin-top: 6px; }
    ul { padding-left: 20px; line-height: 1.8; }
    footer { text-align: center; padding: 20px; color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <header>
    <h1>🌐 反向代理服务</h1>
    <p>基于 Cloudflare Workers 的轻量级请求转发代理</p>
  </header>
  <div class="container">
    <div class="card">
      <h2>📖 使用方式</h2>
      <p>在服务域名后直接拼接目标 URL 即可：</p>
      <div class="example">
        <strong>示例：</strong>
        <code>https://${workerDomain}/https://example.com</code>
        <code>https://${workerDomain}/https://example.com/path?query=1</code>
        <code>https://${workerDomain}/http://example.com:8080</code>
      </div>
    </div>
    <div class="card">
      <h2>✨ 功能特性</h2>
      <ul>
        <li>支持 HTTPS / HTTP 目标</li>
        <li>支持 WebSocket 代理 (wss://)</li>
        <li>HTML 链接自动重写，页面内跳转仍走代理</li>
        <li>CORS 跨域支持</li>
        <li>Cookie 自动适配</li>
        <li>重定向拦截</li>
      </ul>
    </div>
  </div>
  <footer>Powered by Cloudflare Workers</footer>
</body>
</html>`,
        {
          headers: { "content-type": "text/html;charset=UTF-8" },
          status: 200,
        }
      );
    }
    // ==========================================================

    // ================= 3. 从路径中提取目标 URL =================
    // 支持三种格式：
    //   /https://example.com/path   → https://example.com/path
    //   /http://example.com/path    → http://example.com/path
    //   /example.com/path           → https://example.com/path
    const rawPath = url.pathname.slice(1);

    let targetUrlStr;
    if (/^https?:\/[^/]/.test(rawPath)) {
      targetUrlStr = rawPath.replace(/^(https?):\//, '$1://');
    } else if (rawPath.includes('://')) {
      targetUrlStr = rawPath;
    } else if (!rawPath) {
      return new Response('请指定目标地址，例如: https://worker域名/https://example.com', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    } else {
      targetUrlStr = 'https://' + rawPath;
    }

    // search 和 hash
    const targetUrl = new URL(targetUrlStr + url.search + url.hash);
    const proxyPath = '/' + targetUrlStr;
    // ============================================================

    // ================= 4. 复制并清洗请求头 =================
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", targetUrl.host);
    newHeaders.set("Referer", targetUrl.origin);
    newHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    newHeaders.delete("cf-connecting-ip");
    newHeaders.delete("cf-ipcountry");
    newHeaders.delete("cf-ray");
    newHeaders.delete("cf-visitor");

    // specialCases 动态头规则
    applySpecialCases(newHeaders, targetUrl.host);
    // ============================================================

    // ================= 5. WebSocket 代理 =================
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return handleWebSocket(targetUrl);
    }
    // ============================================================

    // ================= 6. 发起对目标网站的 HTTP 请求 =================
    try {
      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        redirect: "manual"
      });

      // ================= 7. 处理响应头 =================
      let modifiedHeaders = buildModifiedHeaders(response, workerDomain, targetUrl);
      // =================================================

      // ================= 8. 重定向拦截 =================
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let location = modifiedHeaders.get("Location");
        if (location) {
          if (location.includes(targetUrl.host)) {
            location = location.replace(targetUrl.host, workerDomain);
            location = location.replace(/^http:/, "https:");
          }
          modifiedHeaders.set("Location", location);
        }
      }
      // =================================================

      // ================= 9. 注入 CORS + Vary =================
      modifiedHeaders.set("Access-Control-Allow-Origin", "*");
      modifiedHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      modifiedHeaders.set("Access-Control-Allow-Headers", "*");

      if (modifiedHeaders.has("Vary")) {
        const vary = modifiedHeaders.get("Vary");
        if (!vary.split(',').map(v => v.trim()).includes('Origin')) {
          modifiedHeaders.set("Vary", vary + ", Origin");
        }
      } else {
        modifiedHeaders.set("Vary", "Origin");
      }
      // =================================================

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: modifiedHeaders });
      }

      // ================= 10. HTML 响应处理 =================
      const contentType = modifiedHeaders.get("Content-Type") || '';

      if (contentType.includes('text/html')) {
        const text = await response.text();
        const rewrittenText = rewriteHtml(text, targetUrl, proxyPath, workerDomain);
        return new Response(rewrittenText, {
          status: response.status,
          statusText: response.statusText,
          headers: modifiedHeaders
        });
      }
      // ====================================================

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

// ================= 辅助函数 =================

// --- 处理响应头 ---
function buildModifiedHeaders(response, workerDomain, targetUrl) {
  const modifiedHeaders = new Headers();

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase();

    if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
      continue;
    }

    if (lowerKey === 'strict-transport-security') {
      continue;
    }

    if (lowerKey === 'clear-site-data') {
      continue;
    }

    if (lowerKey === 'set-cookie') {
      const newValue = value.replace(/;\s*domain\s*=\s*[^;]+\s*/gi, '');
      modifiedHeaders.append(key, newValue);
      continue;
    }

    modifiedHeaders.append(key, value);
  }

  return modifiedHeaders;
}

// --- WebSocket 代理 ---
async function handleWebSocket(targetUrl) {
  const targetWsUrl = targetUrl.toString().replace(/^http/, 'ws');
  const wsResponse = await fetch(targetWsUrl);

  if (wsResponse.status === 101 && wsResponse.webSocket) {
    wsResponse.webSocket.accept();
    return new Response(null, {
      status: 101,
      webSocket: wsResponse.webSocket,
    });
  }

  return wsResponse;
}

// --- specialCases 动态头规则 ---
function applySpecialCases(headers, hostname) {
  // 先应用通配规则 *
  if (specialCases["*"]) {
    applyRules(headers, specialCases["*"]);
  }
  // 再应用具体域名规则（覆盖通配）
  if (specialCases[hostname]) {
    applyRules(headers, specialCases[hostname]);
  }
}

function applyRules(headers, rules) {
  for (const [key, value] of Object.entries(rules)) {
    switch (value) {
      case "KEEP":
        break; // 不做任何操作，保留原始值
      case "DELETE":
        headers.delete(key);
        break;
      default:
        headers.set(key, value);
        break;
    }
  }
}

// --- HTML 重写 ---
function rewriteHtml(text, targetUrl, proxyPath, workerDomain) {
  const escapedOrigin = targetUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let result = text
    // a) 重写绝对 URL（href、src、action、srcset、formaction）
    .replace(
      new RegExp(`((?:href|src|action|srcset|formaction)=["'])${escapedOrigin}`, 'gi'),
      `$1${proxyPath}`
    )
    // b) 处理 inline CSS 中的 url()
    .replace(
      new RegExp(`(url\\(["']?)${escapedOrigin}`, 'gi'),
      `$1${proxyPath}`
    )
    // c) 重写根相对路径（/path → /https:/example.com/path）
    .replace(
      /(<(?:a|base|form|img|link|script|video|audio|source|iframe|embed|area)[^>]*\s(?:href|src|action)=["'])\//gi,
      `$1${proxyPath}/`
    )
    // d) 重写 <base> 标签
    .replace(
      new RegExp(`(<base[^>]*\\shref=["'])${escapedOrigin}`, 'gi'),
      `$1${proxyPath}`
    );

  // 应用 replace_dict 自定义文本替换
  if (Object.keys(replace_dict).length > 0) {
    result = applyReplaceDict(result, targetUrl.host, workerDomain);
  }

  return result;
}

// --- replace_dict 文本替换 ---
function applyReplaceDict(text, upstreamDomain, customDomain) {
  let result = text;

  for (const [keyRaw, valueRaw] of Object.entries(replace_dict)) {
    let search = keyRaw;
    let replace = valueRaw;

    // 解析占位符
    if (search === "$upstream") search = upstreamDomain;
    else if (search === "$custom_domain") search = customDomain;

    if (replace === "$upstream") replace = upstreamDomain;
    else if (replace === "$custom_domain") replace = customDomain;

    // 全局替换
    result = result.split(search).join(replace);
  }

  return result;
}
