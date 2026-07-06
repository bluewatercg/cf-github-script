// Cloudflare Worker - URL 健康检测 API

export default {
  async fetch(request) {
    const url = new URL(request.url).searchParams.get('url');
    if (!url) {
      return new Response(JSON.stringify({
        code: 400,
        error: '缺少 url 参数，请传入 ?url=https://example.com',
        usage: 'https://your-worker.xx.workers.dev/api/status?url=https://example.com'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // 验证 URL 格式
    try { new URL(url); } catch {
      return new Response(JSON.stringify({
        code: 400, url, status: 'invalid_url',
        error: 'URL 格式无效'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const detail = { url, status: 'unknown', http_code: 0, latency_ms: 0, content_type: '', server: '', redirect_chain: [], error: null };

    try {
      const start = Date.now();

      // 优先 HEAD，如果不支持则回退 GET（只读响应头）
      let resp = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        redirect: 'manual'   // 不自动跟随，手动记录重定向链
      });

      // 处理重定向链（最多跟踪 5 跳）
      let redirectUrl = url;
      for (let i = 0; i < 5 && (resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307 || resp.status === 308); i++) {
        const location = resp.headers.get('location');
        if (!location) break;
        redirectUrl = new URL(location, redirectUrl).href;
        detail.redirect_chain.push({ from: redirectUrl, status: resp.status });
        resp = await fetch(redirectUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'manual' });
      }

      // 如果 HEAD 被拒绝（405/501），改用 GET
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': UA,
            'Range': 'bytes=0-0'  // 只请求第一个字节，减少带宽
          },
          redirect: 'manual'
        });
      }

      detail.latency_ms = Date.now() - start;
      detail.http_code = resp.status;
      detail.status = resp.ok ? 'reachable' : 'unreachable';
      detail.content_type = resp.headers.get('content-type') || '';
      detail.server = resp.headers.get('server') || '';
      detail.final_url = resp.url || redirectUrl;

    } catch (err) {
      detail.status = 'unreachable';
      detail.error = err.message;
    }

    return new Response(JSON.stringify(detail, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
