// Cloudflare Worker - URL 健康检测 API + 前端页面
// ============================================
// 访问 /api/status?url=https://example.com → JSON
// 访问 /  → 前端页面

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const urlParam = new URL(request.url).searchParams.get('url');

    // 有 url 参数 → 返回 JSON
    if (urlParam) {
      return handleApi(urlParam);
    }

    // 无 url 参数 → 返回前端页面
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

// ==================== API 逻辑 ====================

async function handleApi(url) {
  // 验证 URL 格式
  try {
    new URL(url);
  } catch {
    return new Response(
      JSON.stringify({ code: 400, url, status: 'invalid_url', error: 'URL 格式无效' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const detail = {
    url,
    status: 'unknown',
    http_code: 0,
    latency_ms: 0,
    content_type: '',
    server: '',
    redirect_chain: [],
    error: null,
  };

  try {
    const start = Date.now();

    // 优先 HEAD，如果不支持则回退 GET
    let resp = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      redirect: 'manual',
    });

    // 处理重定向链（最多跟踪 5 跳）
    let redirectUrl = url;
    for (
      let i = 0;
      i < 5 &&
      (resp.status === 301 ||
        resp.status === 302 ||
        resp.status === 303 ||
        resp.status === 307 ||
        resp.status === 308);
      i++
    ) {
      const location = resp.headers.get('location');
      if (!location) break;
      redirectUrl = new URL(location, redirectUrl).href;
      detail.redirect_chain.push({ from: redirectUrl, status: resp.status });
      resp = await fetch(redirectUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        redirect: 'manual',
      });
    }

    // 如果 HEAD 被拒绝（405/501），改用 GET
    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
        redirect: 'manual',
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
    headers: { 'Content-Type': 'application/json' },
  });
}

// ==================== 前端页面模板 ====================

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>URL 健康检测</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --accent: #58a6ff; --success: #3fb950; --danger: #f85149; --warn: #d29922; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 20px; }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h1 small { font-size: 0.9rem; color: var(--text-muted); font-weight: 400; }
  p.sub { color: var(--text-muted); margin-bottom: 20px; font-size: 14px; }
  h2 { font-size: 1.2rem; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 1rem; margin: 16px 0 8px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .form-row { display: flex; gap: 8px; }
  .form-row input { flex: 1; padding: 10px 14px; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; }
  .form-row input:focus { outline: none; border-color: var(--accent); }
  .form-row button { padding: 10px 24px; background: var(--accent); color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .form-row button:hover { opacity: .85; }
  .form-row button:disabled { opacity: .4; cursor: not-allowed; }
  .loading { display: none; align-items: center; gap: 8px; margin-top: 12px; color: var(--text-muted); font-size: 14px; }
  .loading.show { display: flex; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .result-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin-top: 12px; font-size: 14px; }
  .result-grid .label { color: var(--text-muted); white-space: nowrap; }
  .result-grid .value { word-break: break-all; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge.reachable { background: rgba(63,185,80,.15); color: var(--success); }
  .badge.unreachable { background: rgba(248,81,73,.15); color: var(--danger); }
  .error-msg { color: var(--danger); font-size: 14px; margin-top: 8px; }
  .response-raw { margin-top: 12px; }
  .response-raw summary { cursor: pointer; color: var(--text-muted); font-size: 13px; }
  pre { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
  code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .field { font-family: monospace; color: #f2cc60; }
  .type { font-family: monospace; font-size: 12px; color: var(--text-muted); }
  .endpoint { background: rgba(88,166,255,.1); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; color: var(--accent); }
  footer { text-align:center; color:var(--text-muted); font-size:13px; padding:24px 0 12px 0; border-top:1px solid var(--border); margin-top:24px; }
  footer a { color:inherit; text-decoration:none; }
</style>
</head>
<body>
<div class="container">

<h1>🔗 URL 健康检测</h1>
<p class="sub">检测目标 URL 的可达性、HTTP 状态码、响应延迟、服务器信息</p>

<!-- 在线测试 -->
<h2>🧪 在线检测</h2>
<div class="card">
  <div class="form-row">
    <input type="url" id="urlInput" placeholder="输入 URL，如 https://example.com" value="https://blog.notett.com">
    <button id="checkBtn">检测</button>
  </div>
  <div class="loading" id="loading">
    <div class="spinner"></div>
    <span>正在检测...</span>
  </div>
  <div id="result"></div>
</div>

<!-- API 文档 -->
<h2>📖 API 文档</h2>

<h3>请求方式</h3>
<p><span class="endpoint">GET /api/status?url=&lt;目标URL&gt;</span></p>

<h3>示例</h3>
<pre><code>curl "<span id="apiExample">https://link-check.qa.ccwu.cc/api/status?url=https://blog.notett.com</span>"</code></pre>

<h3>响应字段</h3>
<table>
  <tr><th>字段</th><th>类型</th><th>说明</th></tr>
  <tr><td class="field">status</td><td class="type">string</td><td><code>reachable</code> / <code>unreachable</code> / <code>invalid_url</code></td></tr>
  <tr><td class="field">http_code</td><td class="type">number</td><td>HTTP 状态码（200, 301, 404, 500...）</td></tr>
  <tr><td class="field">latency_ms</td><td class="type">number</td><td>响应延迟（毫秒）</td></tr>
  <tr><td class="field">content_type</td><td class="type">string</td><td>Content-Type 响应头</td></tr>
  <tr><td class="field">server</td><td class="type">string</td><td>Server 响应头（nginx, cloudflare...）</td></tr>
  <tr><td class="field">final_url</td><td class="type">string</td><td>最终请求地址（跟随重定向后）</td></tr>
  <tr><td class="field">redirect_chain</td><td class="type">array</td><td>重定向链 [{from, status}]</td></tr>
  <tr><td class="field">error</td><td class="type">string|null</td><td>错误信息</td></tr>
</table>

<h3>响应示例</h3>
<pre><code>{
  "url": "https://blog.notett.com",
  "status": "reachable",
  "http_code": 200,
  "latency_ms": 312,
  "content_type": "text/html; charset=UTF-8",
  "server": "nginx",
  "final_url": "https://blog.notett.com",
  "redirect_chain": [],
  "error": null
}</code></pre>

<hr style="border:none;border-top:1px solid var(--border);margin:24px 0">
<footer>
  URL 健康检测 · &copy; <span id="year"></span>
  <a href="https://github.com/yutian81" target="_blank">yutian81</a> by
  <a href="https://blog.notett.com" target="_blank">QingYun</a>
</footer>
</div>

<script>
const btn = document.getElementById('checkBtn');
const input = document.getElementById('urlInput');
const loading = document.getElementById('loading');
const result = document.getElementById('result');
const apiExample = document.getElementById('apiExample');

function updateApiExample(url) {
  apiExample.textContent = location.origin + '/api/status?url=' + url;
}

input.addEventListener('input', () => updateApiExample(input.value.trim() || 'https://blog.notett.com'));

async function check() {
  let url = input.value.trim();
  if (!url) { result.innerHTML = '<div class="error-msg">请输入 URL</div>'; return; }
  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;

  loading.classList.add('show');
  btn.disabled = true;
  result.innerHTML = '';

  try {
    const resp = await fetch('/api/status?url=' + encodeURIComponent(url));
    const data = await resp.json();
    renderResult(data);
  } catch (err) {
    result.innerHTML = '<div class="error-msg">请求失败: ' + err.message + '</div>';
  } finally {
    loading.classList.remove('show');
    btn.disabled = false;
  }
}

function renderResult(data) {
  const cls = data.status === 'reachable' ? 'badge reachable' : data.status === 'unreachable' ? 'badge unreachable' : 'badge';
  const txt = data.status === 'reachable' ? '✅ 可达' : data.status === 'unreachable' ? '❌ 不可达' : '⚠️ ' + data.status;

  let html = '<div class="result-grid">';
  html += '<span class="label">状态</span><span class="value"><span class="' + cls + '">' + txt + '</span></span>';
  html += '<span class="label">HTTP 状态码</span><span class="value">' + (data.http_code || '-') + '</span>';
  html += '<span class="label">响应延迟</span><span class="value">' + (data.latency_ms ? data.latency_ms + ' ms' : '-') + '</span>';
  html += '<span class="label">Content-Type</span><span class="value">' + (data.content_type || '-') + '</span>';
  html += '<span class="label">服务器</span><span class="value">' + (data.server || '-') + '</span>';
  html += '<span class="label">最终 URL</span><span class="value">' + (data.final_url || '-') + '</span>';

  if (data.redirect_chain && data.redirect_chain.length > 0) {
    html += '<span class="label">重定向链</span><span class="value">';
    data.redirect_chain.forEach(function(r, i) {
      html += '<div style="font-size:12px;color:var(--text-muted)">#' + (i+1) + ' ' + r.status + ' → ' + r.from + '</div>';
    });
    html += '</span>';
  }
  if (data.error) {
    html += '<span class="label">错误信息</span><span class="value" style="color:var(--danger)">' + data.error + '</span>';
  }
  html += '</div>';
  html += '<div class="response-raw"><details><summary>查看原始 JSON</summary><pre><code>' + JSON.stringify(data, null, 2) + '</code></pre></details></div>';
  result.innerHTML = html;
}

btn.addEventListener('click', check);
input.addEventListener('keydown', function(e) { if (e.key === 'Enter') check(); });
updateApiExample(input.value);
document.getElementById('year').textContent = new Date().getFullYear();
check();
</script>
</body>
</html>`;
