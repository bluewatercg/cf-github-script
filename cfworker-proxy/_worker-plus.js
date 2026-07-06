// ================= 配置区域 =================
// 目标网站的地址（结尾不要加斜杠 /）
const TARGET_URL = "https://example.com"; 
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.host; // 当前 Worker 的域名

    // 1. 构建要请求的目标 URL
    const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

    // 2. 复制并清洗请求头
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", targetUrl.host);
    newHeaders.set("Referer", TARGET_URL);
    
    // 指定为最新的 PC 端 Chrome UA，防止原站因底层 CDN 特征拦截
    newHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    
    // 移除可能导致解析冲突或暴露 Cloudflare 特征的头部
    newHeaders.delete("cf-connecting-ip");
    newHeaders.delete("cf-ipcountry");
    newHeaders.delete("cf-ray");
    newHeaders.delete("cf-visitor");

    // 3. 发起对目标网站的请求
    try {
      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        redirect: "manual" // 手动处理重定向，拦截 301/302
      });

      // 4. 复制响应头，准备进行修改
      let modifiedHeaders = new Headers(response.headers);

      // 【重定向拦截】
      // 如果原站返回 30x 重定向，其 Location 头会指向原站地址，我们必须将其篡改回 Worker 域名
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let location = modifiedHeaders.get("Location");
        if (location) {
          // 如果重定向包含目标域名，替换为当前 Worker 域名
          if (location.includes(targetUrl.host)) {
            location = location.replace(targetUrl.host, workerDomain);
            // 确保协议强制为 https 保证安全性
            location = location.replace(/^http:/, "https:");
          }
          modifiedHeaders.set("Location", location);
        }
      }

      // 5. 注入跨域（CORS）响应头，方便前端接口直接调用
      modifiedHeaders.set("Access-Control-Allow-Origin", "*");
      modifiedHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      modifiedHeaders.set("Access-Control-Allow-Headers", "*");

      // 如果是前端发起的预检请求 (OPTIONS)，直接返回 204
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: modifiedHeaders
        });
      }

      // 6. 返回修改后的响应给用户浏览器
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
