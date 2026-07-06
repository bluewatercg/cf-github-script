// ================= 配置 =================
const TARGET_URL = "https://example.com"; // ← 改成你要代理的目标网站
// =========================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search + url.hash, TARGET_URL);

    // ========== 1. 清洗请求头 ==========
    const headers = new Headers(request.headers);
    headers.set("Host", targetUrl.host);
    headers.set("Referer", targetUrl.origin);
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    for (const k of ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor"]) headers.delete(k);

    // ========== 2. WebSocket ==========
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const ws = await fetch(targetUrl.toString().replace(/^http/, "ws"));
      if (ws.status === 101 && ws.webSocket) { ws.webSocket.accept(); return new Response(null, { status: 101, webSocket: ws.webSocket }); }
      return ws;
    }

    try {
      const res = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
        redirect: "manual",
      });

      // ========== 3. 构建响应头（过滤 + 重写）==========
      const out = new Headers();
      for (const [k, v] of res.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk === "content-security-policy" || lk === "content-security-policy-report-only" ||
            lk === "strict-transport-security" || lk === "clear-site-data") continue;
        if (lk === "set-cookie") { out.append(k, v.replace(/;\s*domain\s*=\s*[^;]+\s*/gi, "")); continue; }
        out.append(k, v);
      }

      // ========== 4. 重定向拦截 ==========
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = out.get("Location");
        if (loc?.includes(targetUrl.host)) out.set("Location", loc.replace(targetUrl.host, url.host).replace(/^http:/, "https:"));
      }

      // ========== 5. CORS ==========
      out.set("Access-Control-Allow-Origin", "*");
      out.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      out.set("Access-Control-Allow-Headers", "*");
      const vary = out.get("Vary") || "";
      if (!vary.split(",").map(v => v.trim()).includes("Origin")) out.set("Vary", vary ? vary + ", Origin" : "Origin");

      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: out });

      // ========== 6. HTML 链接重写 ==========
      if ((out.get("Content-Type") || "").includes("text/html")) {
        const text = await res.text();
        const escTarget = targetUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const workerOrigin = url.origin;
        const rewritten = text
          .replace(new RegExp(`((?:href|src|action|srcset|formaction)=["'])${escTarget}`, "gi"), `$1${workerOrigin}`)
          .replace(new RegExp(`(url\\(["']?)${escTarget}`, "gi"), `$1${workerOrigin}`)
          .replace(new RegExp(`(<base[^>]*\\shref=["'])${escTarget}`, "gi"), `$1${workerOrigin}`);
        return new Response(rewritten, { status: res.status, statusText: res.statusText, headers: out });
      }

      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  },
};
