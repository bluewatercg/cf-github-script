// 通用响应构造器
const jsonResponse = (data, status = 200, headers = {}) => 
  new Response(JSON.stringify(data), { 
    status, 
    headers: { 'Content-Type': 'application/json', ...headers } 
  });

const htmlResponse = (html, headers = {}) =>
  new Response(html, { headers: { 'Content-Type': 'text/html', ...headers } });

const corsHeaders = (headers = {}) => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  ...headers
});

// Github API 请求头
function githubHeaders(env, requestHeaders) {
  const authHeader = requestHeaders.get('Authorization');
  const token = authHeader ? authHeader.replace('Bearer ', '') : env.GH_TOKEN;
  return {
    'Authorization': `token ${token}`,  // 优先使用请求头的 Token
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Cloudflare-Worker-Github',
  };
}

// Github速率限制检查
function checkRateLimit(headers) {
  const remaining = parseInt(headers.get('x-ratelimit-remaining'));
  if (remaining < 10) {
    console.warn(`GitHub API 剩余调用次数: ${remaining}`);
  }
}

// 获取GitHub文件sha
async function getFileSHA(apiUrl, env, request) {
  try {
    const response = await fetch(apiUrl, { 
      headers: githubHeaders(env, request.headers)
    });
    checkRateLimit(response.headers);
    if (response.status === 401) throw new Error('Github Token 无效或权限不足');
    if (response.status === 404) {
      console.log('文件不存在，将创建新记录');
      return null;
    }  
    if (!response.ok) return null;
    const data = await response.json();
    return data.sha || null;  
  } catch (error) {
    console.error('SHA 获取失败:', error);
    throw error;
  }
}

// 检查Gist是否存在
async function checkGistExists(gistId, env, request) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: githubHeaders(env, request.headers)
  });
  return res.status === 200;
}

// 清洗路径
function cleanPath(path) {
  return (path || '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
}

// 编码函数
function encodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// 拼接直链地址
async function buildDirectUrl(uploadType, username, idORrepo, branch, path, filename, env, event, request) {
  const filePath = path ? `${cleanPath(path)}/${filename}` : filename;
  if (uploadType === 'gist') {
    return `https://gist.githubusercontent.com/${username}/${idORrepo}/raw/${filename}`;
  }
  const isPrivate = await checkRepoIsPrivate(username, idORrepo, env, event, request);
  return isPrivate && env.RAW_DOMAIN
    ? `https://${env.RAW_DOMAIN}/${idORrepo}/${branch}/${filePath}?token=yutian88881`
    : `https://github.com/${username}/${idORrepo}/raw/${branch}/${filePath}`;
}

// 检查仓库是否为私有（带缓存）
async function checkRepoIsPrivate(username, repo, env, event, request) {
  const cacheKey = new Request(`https://gitcache.example.com/repo_privacy/${username}/${repo}`);
  const cache = caches.default; // 尝试从缓存获取
  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      return (await cached.json()).private;
    } catch (e) {
      console.log('缓存解析失败，重新获取');
    }
  }
  
  try {
    const response = await fetch(`https://api.github.com/repos/${username}/${repo}`, {
      headers: githubHeaders(env, request.headers)
    });
    if (!response.ok) return false; //按公开仓库处理
    const repoData = await response.json();
    const isPrivate = repoData.private === true;
    const cacheResponse = new Response(JSON.stringify(repoData), {
      headers: {
        'Cache-Control': 'max-age=3600', // 将结果缓存1小时（3600秒）
        'Content-Type': 'application/json'
      }
    });
    // 使用waitUntil确保缓存操作不影响主流程
    const cachePromise = cache.put(cacheKey, cacheResponse); 
    if (event) { event.waitUntil(cachePromise); }
    else { await cachePromise; }
    return isPrivate;
  } catch (error) { return false; } //出错时按公开仓库处理
}

// 初始化数据库
async function initializeDatabase(db) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS git_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        filesize TEXT NOT NULL,
        upload_type TEXT NOT NULL CHECK (upload_type IN ('gist', 'github')),
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        gist_id TEXT,
        gh_user TEXT,
        gh_repo TEXT,
        gh_branch TEXT DEFAULT 'main',
        gh_path TEXT DEFAULT '/',
        page_url TEXT,
        direct_url TEXT
      )
    `).run();
  } catch (error) {
    console.error('数据库初始化错误:', error);
    throw error;
  }
}

export default {
  async fetch(request, env, event) {
    const { pathname, searchParams } = new URL(request.url);    
    await initializeDatabase(env.GH_DB);
    const routes = {
      '/': () => htmlResponse(HTML, corsHeaders()),
      '/list': () => htmlResponse(listHTML, corsHeaders()),
      '/api/upload': () => handleUpload(request, env, event),
      '/api/qry': () => handleFileQuery(env, searchParams),
      '/api/rec/(\\d+(?:,\\d+)*)': (req, ids) => handleDeleteRecord(ids, env, req),
      '/api/del/(\\d+(?:,\\d+)*)': (req, ids) => handleDeleteFile(ids, env, req)
    };

    for (const [path, handler] of Object.entries(routes)) {
      const match = pathname.match(new RegExp(`^${path}$`));
      if (match) return await handler(request, ...match.slice(1));
    }
    return jsonResponse({ error: '不存在的页面' }, 404, corsHeaders());
  }
};

// 上传请求
async function handleUpload(request, env, event) {
  const corsHeader = corsHeaders();
  if (request.method !== 'POST') {
    return jsonResponse({ error: '不支持该请求方式' }, 405, corsHeader);
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll('files');
    if (!files.length) return jsonResponse({ error: '未选择任何文件' }, 400, corsHeader);
    
    const results = [];
    for (const file of files) {
      try {
        const fileData = await processFile(file, formData, env, event, request);
        await saveToDatabase(fileData, env.GH_DB);
        results.push(fileData);
      } catch (err) {
        results.push({
          filename: file.name,
          error: err.message
        });
      }
      // 添加短暂间隔避免GitHub API速率限制
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return jsonResponse(results, 201, corsHeader);
  } catch (err) {
    return jsonResponse({ 
      error: err.message
    }, 500, corsHeader);
  }
}

// ========== 单文件处理 ==========
async function processFile(file, formData, env, event, request) {
  const fileData = {
    filename: file.name,
    filesize: formatSize(file.size),
    upload_type: formData.get('upload-type'),
    upload_time: new Date().toISOString()
  };

  if (fileData.upload_type === 'gist') {
    await processGist(file, formData, fileData, env, event, request);
  } else {
    await processGitHub(file, formData, fileData, env, event, request);
  }
  if (fileData.direct_url instanceof Promise) {
    fileData.direct_url = await fileData.direct_url;
  }
  return fileData;
}

// ========== Gist处理 ==========
async function processGist(file, formData, fileData, env, event, request) {
  const isPublic = formData.get('gist-public') === 'on';
  const existingGistId = formData.get('existing-gist')?.trim();
  const content = await file.text();
  const gistUrl = existingGistId 
    ? `https://api.github.com/gists/${existingGistId}`
    : 'https://api.github.com/gists';

  const response = await fetch(gistUrl, {
    method: existingGistId ? 'PATCH' : 'POST',
    headers: githubHeaders(env, request.headers),
    body: JSON.stringify({
      public: isPublic,
      files: { [file.name]: { content } }
    }),
  });

  if (!response.ok) throw new Error(`Gist API 错误: ${await response.text()}`);
  
  const gist = await response.json();
  if (!gist.owner?.login) throw new Error('Gist 缺少用户名信息');

  fileData.page_url = gist.html_url;
  fileData.direct_url = buildDirectUrl('gist', gist.owner.login, gist.id, '', '', file.name, env, event, request);
  fileData.gist_id = gist.id;
}

// ========== Github处理 ==========
async function processGitHub(file, formData, fileData, env, event, request) {
  const username = formData.get('gh-user')?.trim();
  const repo = formData.get('gh-repo')?.trim();
  if (!username || !repo) throw new Error('需要 GitHub 用户名和仓库名');
 
  const content = encodeBase64(await file.text());
  const branch = formData.get('gh-branch')?.trim() || 'main';
  const rawPath = formData.get('gh-path')?.trim() || '/';
  const cleanPathStr = cleanPath(rawPath);
  const apiPath = cleanPathStr
    ? `${encodeURIComponent(cleanPathStr)}/${encodeURIComponent(file.name)}`
    : encodeURIComponent(file.name);
  const apiUrl = `https://api.github.com/repos/${username}/${repo}/contents/${apiPath}?ref=${branch}`;

  // 获取已有文件的SHA并更新
  const sha = await getFileSHA(apiUrl, env, request);
  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: githubHeaders(env, request.headers),
    body: JSON.stringify({
      message: `Git-Files upload: ${file.name}`,
      content,
      branch,
      ...(sha && { sha })
    }),
  });
  if (!response.ok) throw new Error(`GitHub API 错误: ${await response.text()}`);

  const pagePath = cleanPathStr ? `${cleanPathStr}/${file.name}` : file.name;
  fileData.gh_user = username;
  fileData.gh_repo = repo;
  fileData.gh_branch = branch;
  fileData.gh_path = cleanPathStr;
  fileData.page_url = `https://github.com/${username}/${repo}/blob/${branch}/${pagePath}`;
  fileData.direct_url = await buildDirectUrl('github', username, repo, branch, cleanPathStr, file.name, env, event, request);
}

// 数据库操作
async function saveToDatabase(data, db) {
  const { 
    filename, filesize, upload_type, upload_time,
    gist_id, gh_user, gh_repo,
    gh_branch, gh_path, page_url, direct_url 
  } = data;

  let existingId;

  // 检查是否存在重复记录
  if (upload_type === 'gist') {
    const existing = await db.prepare(
      'SELECT id FROM git_files WHERE upload_type = ? AND gist_id = ? AND filename = ?'
    ).bind(upload_type, gist_id, filename).first();
    existingId = existing?.id;
  } else if (upload_type === 'github') {
    const existing = await db.prepare(
      'SELECT id FROM git_files WHERE upload_type = ? AND gh_user = ? AND gh_repo = ? AND gh_branch = ? AND gh_path = ? AND filename = ?'
    ).bind(upload_type, gh_user, gh_repo, gh_branch, gh_path, filename).first();
    existingId = existing?.id;
  }

  if (existingId) {
    // 更新现有记录
    await db.prepare(`
      UPDATE git_files 
      SET filesize = ?, 
          upload_time = ?, 
          page_url = ?, 
          direct_url = ?
      WHERE id = ?
    `).bind(
      filesize,
      upload_time,
      page_url,
      direct_url,
      existingId
    ).run();
  } else {
    // 插入新记录（注意 gh_path 不再强制设置默认值 '/')
    await db.prepare(`
      INSERT INTO git_files (
        filename, filesize, upload_type, upload_time,
        gist_id, gh_user, gh_repo,
        gh_branch, gh_path, page_url, direct_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      filename || '',
      filesize || '',
      upload_type || '',
      upload_time || '',
      gist_id ?? null,
      gh_user ?? null,
      gh_repo ?? null,
      gh_branch || '',
      gh_path || '',
      page_url || '',
      direct_url || ''
    ).run();
  }
}

// 文件查询
async function handleFileQuery(env, params) {
  const corsHeader = corsHeaders();
  const allPages = params.get('all_pages') === 'true';
  if (allPages && params.has('page')) {
    return jsonResponse(
      { error: "all_pages参数不能与page参数共存" },
      400, corsHeader
    );
  }

  let baseSQL = `
    SELECT id, filename, filesize, upload_type,
           upload_time, page_url, direct_url
    FROM git_files
    ORDER BY upload_time DESC
  `;

  let query;
  if (allPages) {
    query = env.GH_DB.prepare(`${baseSQL} LIMIT ?`).bind(5000);
  } else {
    const page = parseInt(params.get('page')) || 1;
    const limit = 20;
    query = env.GH_DB.prepare(`${baseSQL} LIMIT ? OFFSET ?`)
      .bind(limit, (page - 1) * limit);
  }
  const result = await query.all();
  if (allPages) corsHeader['Cache-Control'] = 'public, max-age=600';
  return jsonResponse(result.results || [], 200, corsHeader);
}

// ========== 通用删除操作处理器 ==========
async function handleDeleteOperation(idsParam, env, request, operationType, processRecordCallback) {
  const corsHeader = corsHeaders();
  if (request.method !== 'DELETE') {
    return jsonResponse({ error: '不支持的请求方式' }, 405, corsHeader);
  }

  // 解析并验证ID参数
  const ids = idsParam.split(',')
    .map(id => parseInt(id))
    .filter(id => !isNaN(id));
  if (!ids.length) return jsonResponse({ error: '无效ID参数' }, 400, corsHeader);

  try {
    const results = [];
    for (const id of ids) {
      try {
        // 查询数据库记录（公共逻辑）
        const record = await env.GH_DB.prepare(
          'SELECT * FROM git_files WHERE id = ?'
        ).bind(id).first();

        // 调用回调函数处理具体逻辑
        const result = await processRecordCallback(id, record, env, request);
        results.push(result);
      } catch (error) {
        results.push({
          id,
          success: false,
          filename: record?.filename || null,
          upload_type: record?.upload_type || null,
          error: error.message
        });
      }
      await new Promise(r => setTimeout(r, 800)); // 速率限制（公共逻辑）
    }

    // 统一响应格式（公共逻辑）
    return jsonResponse({
      operation: operationType,
      total: ids.length,
      success_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length,
      results
    }, 200, corsHeader);
  } catch (err) {
    return jsonResponse({ error: `操作失败: ${err.message}` }, 500, corsHeader);
  }
}

// 删除数据库记录
async function handleDeleteRecord(idsParam, env, request) {
  return handleDeleteOperation(
    idsParam, env, request, '删除记录',
    async (id, record) => {
      if (!record) {
        return { id, success: false, error: '记录不存在' };
      }
      // 具体删除逻辑
      const result = await env.GH_DB.prepare(
        'DELETE FROM git_files WHERE id = ?'
      ).bind(id).run();
      return {
        id,
        success: result.success,
        filename: record.filename,
        upload_type: record.upload_type,
        error: result.success ? null : '数据库删除失败'
      };
    }
  );
}

// 删除文件+数据库记录
async function handleDeleteFile(idsParam, env, request) {
  return handleDeleteOperation(
    idsParam, env, request, '删除文件',
    async (id, record, env, request) => {
      if (!record) {
        return { id, success: false, error: '记录不存在' };
      }
      if (record.upload_type === 'gist') {
        await deleteGistFile(record, env, request);
        const gistExists = await checkGistExists(record.gist_id, env, request);
        if (!gistExists) {
          await env.GH_DB.prepare(
            'DELETE FROM git_files WHERE gist_id = ?'
          ).bind(record.gist_id).run();
        }
      } else if (record.upload_type === 'github') {
        await deleteGitHubFile(record, env, request);
      }

      // 删除数据库记录
      await env.GH_DB.prepare(
        'DELETE FROM git_files WHERE id = ?'
      ).bind(id).run();

      return {
        id,
        success: true,
        filename: record.filename,
        upload_type: record.upload_type
      };
    }
  );
}

// GitHub文件删除逻辑
async function deleteGitHubFile(record, env, request) {
  const { gh_user, gh_repo, gh_branch, gh_path, filename } = record;
  const cleanedPath = cleanPath(gh_path || '');
  const pathParts = cleanedPath.split('/').filter(p => p).map(p => encodeURIComponent(p));
  const fullPath = [...pathParts, encodeURIComponent(filename)].join('/');
  
  const apiUrl = `https://api.github.com/repos/${gh_user}/${gh_repo}/contents/${fullPath}?ref=${gh_branch}`;
  const sha = await getFileSHA(apiUrl, env, request);
  
  if (!sha) throw new Error('文件不存在于GitHub');
  
  const response = await fetch(apiUrl, {
    method: 'DELETE',
    headers: githubHeaders(env, request.headers),
    body: JSON.stringify({
      message: `删除文件: ${filename}`,
      sha,
      branch: gh_branch
    })
  });
  checkRateLimit(response.headers);
  if (!response.ok) throw new Error(`GitHub API错误: ${await response.text()}`);
}

// Gist文件删除逻辑
async function deleteGistFile(record, env, request) {
  const { gist_id, filename } = record;
  const gistUrl = `https://api.github.com/gists/${gist_id}`;
  
  // 获取Gist完整数据
  const res = await fetch(gistUrl, { headers: githubHeaders(env, request.headers) });
  if (!res.ok) throw new Error(`获取Gist失败: ${await res.text()}`);
  const gistData = await res.json();
  const files = Object.keys(gistData.files);
  
  if (files.length === 1) {
    // 当仅剩一个文件时删除整个Gist
    const deleteRes = await fetch(gistUrl, {
      method: 'DELETE',
      headers: githubHeaders(env, request.headers)
    });
    if (!deleteRes.ok) throw new Error(`删除Gist失败: ${await deleteRes.text()}`);
  } else {
    // 多个文件时仅删除指定文件
    const updateRes = await fetch(gistUrl, {
      method: 'PATCH',
      headers: githubHeaders(env, request.headers),
      body: JSON.stringify({
        files: { [filename]: null }
      })
    });
    if (!updateRes.ok) throw new Error(`更新Gist失败: ${await updateRes.text()}`);
  }
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// 北京时间函数
function bjTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe.toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function headLinks() {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📁</text></svg>" type="image/svg+xml">
    <link href="https://unpkg.com/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  `;
}

// HTML版权页
function copyright() {
  return `
    <p class="mb-0">
      <span class="item">Copyright © 2025 Yutian81</span>
      <span class="separator mx-2">|</span>
      <a href="https://github.com/yutian81/cf-github-script/tree/main/gist-raw" class="item text-blue-600 hover:text-blue-800" target="_blank">
        <i class="fab fa-github me-1"></i> GitHub
      </a>
      <span class="separator mx-2">|</span>
      <a href="https://blog.811520.xyz/" class="item text-blue-600 hover:text-blue-800" target="_blank">  
        <i class="fas fa-blog me-1"></i> 青云志博客
      </a>
    </p>
  `;
}

// ========== 前端模板 ==========
const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>GitHub 文件服务器</title>
  ${headLinks()}
  <style>
    .dropzone {
      border: 2px dashed #e5e7eb;
      border-radius: 0.5rem;
      padding: 2rem;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
    }
    .dropzone:hover {
      border-color: #3b82f6;
      background-color: #f8fafc;
    }
    .dropzone.dragover {
      border-color: #3b82f6;
      background-color: #eff6ff;
    }
    .form-select {
      width: 400px;
      padding: 0.5rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      height: 2.5rem;
    }
    .form-input {
      border: 1px solid #e5e7eb;
      border-radius: 0.5rem;
      padding: 0.5rem;
      height: 2.5rem;
      width: 100%;
    }
    .footer {
      background-color: #1e3a8a;
      color: white;
      padding: 1rem;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      font-size: 0.875rem;
      z-index: 10;
    }
    .footer a {
      color: white;
    }
    .footer a:hover {
      color: #bfdbfe;
    }
    .result-table {
      max-height: 300px;
      overflow-y: auto;
    }
    .selected-files {
      margin-top: 1rem;
      padding: 0.5rem;
      background-color: #f3f4f6;
      border-radius: 0.25rem;
    }
    .selected-file {
      display: flex;
      align-items: center;
      padding: 0.25rem 0;
    }
    .selected-file i {
      margin-right: 0.5rem;
      color: #3b82f6;
    }
    .form-label {
      display: block;
      margin-bottom: 0.75rem;
      font-weight: 500;
      color: #374151;
    }
    .progress-container {
      flex-grow: 1;
      margin-left: 1rem;
    }
    .upload-controls {
      display: flex;
      align-items: center;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body class="bg-gray-100">
  <!-- 顶部导航栏 -->
  <nav class="bg-blue-800 shadow">
    <div class="container mx-auto px-6 py-4">
      <div class="flex justify-between items-center">
        <a href="https://github.com/yutian81/cf-github-script/tree/main/gist-raw" class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
          <i class="fab fa-github mr-2"></i>项目仓库
        </a>
        <h1 class="text-2xl font-bold text-white text-center">GitHub 文件服务器</h1>
        <a href="/list" class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"><i class="fas fa-folder-open mr-2"></i>文件管理</a>
      </div>
    </div>
  </nav>

  <!-- 主内容区域 -->
  <div class="container mx-auto px-6 py-8" style="max-width: 1300px;">
    <div class="bg-white p-6 rounded-lg shadow-md">
      <!-- 上传类型选择 -->
      <div class="upload-controls">
        <select id="upload-type" class="form-select">
          <option value="gist">Gist</option>
          <option value="github">GitHub</option>
        </select>
        <button id="upload-btn" class="ml-4 px-6 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 flex items-center">
          <i class="fas fa-upload mr-2"></i>上传
        </button>
        <div id="progress-container" class="progress-container hidden">
          <div class="flex justify-between text-sm text-gray-600 mb-1">
            <span>上传进度</span>
            <span id="progress-percent">0%</span>
          </div>
          <div id="progress-bar" class="h-2 bg-gray-200 rounded-full">
            <div id="progress" class="h-full bg-blue-500 rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
        </div>
      </div>
      
      <!-- Gist 选项 -->
      <div id="gist-options" class="mt-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="form-label">可见性</label>
            <select id="gist-visibility" class="form-input">
              <option value="private">私有</option>
              <option value="public">公开</option>
            </select>
          </div>
          <div>
            <label class="form-label">Gist ID (可选)</label>
            <input type="text" id="existing-gist" class="form-input" placeholder="留空则创建新Gist">
          </div>
        </div>
      </div>
      <!-- GitHub 选项 -->
      <div id="github-options" class="mt-4 hidden">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div><label class="form-label">用户名*</label><input type="text" id="gh-user" class="form-input" required placeholder="必须"></div>
          <div><label class="form-label">仓库名*</label><input type="text" id="gh-repo" class="form-input" required placeholder="必须"></div>
          <div><label class="form-label">分支</label><input type="text" id="gh-branch" class="form-input" placeholder="main"></div>
          <div><label class="form-label">路径</label><input type="text" id="gh-path" class="form-input" placeholder="/"></div>
        </div>
      </div>
      <!-- 拖放区 -->
      <div id="dropzone" class="dropzone mt-6">
        <input type="file" id="file-input" multiple class="hidden">
        <p class="text-lg text-gray-600 mb-2">
          <i class="fas fa-cloud-upload-alt text-blue-500"></i>
        </p>
        <p class="text-sm text-gray-500">拖放文件到此处或 <span class="text-blue-600 cursor-pointer" onclick="document.getElementById('file-input').click()">选择文件</span></p>
      </div>
      <!-- 已选文件列表 -->
      <div id="selected-files" class="selected-files hidden">
        <p class="text-sm font-medium text-gray-700 mb-2">已选文件:</p>
        <div id="selected-files-list"></div>
      </div>
      <!-- 上传结果展示区 -->
      <div id="upload-results" class="mt-6 hidden">
        <div class="result-table border rounded-lg overflow-hidden">
          <table class="min-w-full">
            <thead class="bg-gray-100">
              <tr>
                <th class="px-4 py-2 text-left">文件名</th>
                <th class="px-4 py-2 text-left">文件大小</th>
                <th class="px-4 py-2 text-left">上传时间</th>
                <th class="px-4 py-2 text-left">页面地址</th>
                <th class="px-4 py-2 text-left">直链地址</th>
              </tr>
            </thead>
            <tbody id="result-body" class="divide-y divide-gray-200"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  <!-- 页脚统一样式 -->
  <footer class="footer text-center">
    ${copyright()}
  </footer>

  <script>
    const uploadType = document.getElementById('upload-type');
    const gistOpts = document.getElementById('gist-options');
    const githubOpts = document.getElementById('github-options');
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadResults = document.getElementById('upload-results');
    const resultBody = document.getElementById('result-body');
    const selectedFiles = document.getElementById('selected-files');
    const selectedFilesList = document.getElementById('selected-files-list');
    const progressContainer = document.getElementById('progress-container');
    const progressPercent = document.getElementById('progress-percent');

    // 初始化显示GIST选项
    gistOpts.classList.remove('hidden');
    
    // 上传类型切换
    uploadType.addEventListener('change', () => {
      gistOpts.classList.toggle('hidden', uploadType.value !== 'gist');
      githubOpts.classList.toggle('hidden', uploadType.value !== 'github');
    });

    // 文件选择处理
    fileInput.addEventListener('change', updateSelectedFiles);
    
    // 拖放功能
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, highlight, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, unhighlight, false);
    });
    
    function highlight() {
      dropzone.classList.add('dragover');
    }
    
    function unhighlight() {
      dropzone.classList.remove('dragover');
    }
    
    dropzone.addEventListener('drop', handleDrop, false);
    
    function handleDrop(e) {
      const dt = e.dataTransfer;
      const files = dt.files;
      fileInput.files = files;
      updateSelectedFiles();
    }
    
    function updateSelectedFiles() {
      const files = fileInput.files;
      const formatFileSize = ${formatSize.toString()};
      if (files.length > 0) {
        selectedFilesList.innerHTML = '';
        Array.from(files).forEach(file => {
          const fileEl = document.createElement('div');
          fileEl.className = 'selected-file';
          fileEl.innerHTML = \`
            <i class="fas fa-file"></i>
            <span>\${file.name} (\${formatFileSize(file.size)})</span>
          \`;
          selectedFilesList.appendChild(fileEl);
        });
        selectedFiles.classList.remove('hidden');
      } else {
        selectedFiles.classList.add('hidden');
      }
    }
    
    // 上传处理
    uploadBtn.addEventListener('click', async () => {
      const files = fileInput.files;
      if (!files.length) return alert('请选择文件');

      const formData = new FormData();
      formData.append('upload-type', uploadType.value);

      if (uploadType.value === 'gist') {
        const gistVisibility = document.getElementById('gist-visibility').value;
        formData.append('gist-public', gistVisibility === 'public' ? 'on' : 'off');
        formData.append('existing-gist', document.getElementById('existing-gist').value);
      } else {
        formData.append('gh-user', document.getElementById('gh-user').value);
        formData.append('gh-repo', document.getElementById('gh-repo').value);
        formData.append('gh-branch', document.getElementById('gh-branch').value || 'main');
        formData.append('gh-path', document.getElementById('gh-path').value || '/');
      }

      for (const file of files) formData.append('files', file);

      uploadBtn.disabled = true;
      try {
        progressContainer.classList.remove('hidden');
        progressPercent.textContent = '0%';
        document.getElementById('progress').style.width = '0%';
        const xhr = new XMLHttpRequest();
        
        await new Promise(resolve => requestAnimationFrame(resolve));
        xhr.open('POST', '/api/upload', true);
        const totalSize = Array.from(files).reduce((sum, file) => sum + file.size, 0);
        const formatSize = (bytes) => {
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
          if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
          return (bytes / 1073741824).toFixed(1) + ' GB';
        };

        xhr.upload.onprogress = function(e) {
          if (e.lengthComputable) {
            requestAnimationFrame(() => {
              const percent = Math.min(99, Math.round((e.loaded * 100) / e.total));
              const loadedSize = formatSize(e.loaded);
              const totalSize = formatSize(e.total);
              document.getElementById('progress').style.width = \`\${percent}%\`;
              progressPercent.textContent = \`\${percent}%\`;
              document.getElementById('progress-size').textContent = 
                \`\${loadedSize} / \${totalSize}\`;
            });
          }
        };
        
        xhr.onload = function() {
          requestAnimationFrame(() => {
            document.getElementById('progress').style.width = '100%';
            progressPercent.textContent = '100%';
            document.getElementById('progress-size').textContent = '上传完成';
          });
          setTimeout(() => {
            progressContainer.classList.add('hidden');
            if (xhr.status === 201) {
              const results = JSON.parse(xhr.response);
              showUploadResults(results);
              fileInput.value = '';
              selectedFiles.classList.add('hidden');
            } else {
              let errMsg = '上传失败';
              try {
                const res = JSON.parse(xhr.response);
                errMsg += res.error ? (': ' + res.error) : '';
              } catch {}
              alert(errMsg);
            }
          }, 800); // 保持800ms完成状态
        };
        
        xhr.onerror = function() {
          requestAnimationFrame(() => {
            document.getElementById('progress').style.width = '100%';
            progressPercent.textContent = '100%';
            document.getElementById('progress-size').textContent = '网络错误';
          });
          setTimeout(() => {
            progressContainer.classList.add('hidden');
            alert('网络连接异常');
          }, 800);
        };
        xhr.send(formData);
      } catch (error) {
        alert(\`错误：\${error.message}\`);
        progressContainer.classList.add('hidden');
      } finally {
        uploadBtn.disabled = false;
      }
    });

    // 显示上传结果
    function showUploadResults(results) {
      const bjTime = ${bjTime.toString()};
      const escapeHtml = ${escapeHtml.toString()};
      resultBody.innerHTML = results.map(result => \`
        <tr>
          <td class="px-4 py-2">\${escapeHtml(result.filename)}</td>
          <td class="px-4 py-2">\${escapeHtml(result.filesize)}</td>
          <td class="px-4 py-2">\${bjTime(result.upload_time)}</td>
          <td class="px-4 py-2">
            <a href="\${escapeHtml(result.page_url)}" target="_blank" class="text-blue-600 hover:underline">查看</a>
          </td>
          <td class="px-4 py-2">
            <a href="\${escapeHtml(result.direct_url)}" target="_blank" class="text-blue-600 hover:underline">查看</a>
          </td>
        </tr>
      \`).join('');
      uploadResults.classList.remove('hidden');
      progressContainer.classList.add('hidden');
    }
  </script>
</body>
</html>`;

// ========== 列表页模板 ==========
const listHTML = `<!DOCTYPE html>
<html>
<head>
  <title>文件管理</title>  
  ${headLinks()}
  <style>
      body { 
        background-color: #f3f4f6; 
        padding-bottom: 5rem;
      }
      .main-container {
        min-height: calc(100vh - 10rem);
      }
      
      /* 表格相关样式 */
      .table-container {
        overflow-x: auto;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        margin-bottom: 4rem;
        background-color: white;
      }
      .table {
        width: 100%;
      }
      .table th, 
      .table td {
        text-align: center;
        vertical-align: middle;
        padding: 0.75rem;
        font-size: 0.875rem;
        border: 1px solid #e5e7eb;
      }
      .table th {
        background-color: #f9fafb;
        font-weight: 600;
        color: #4b5563;
      }
      .table tbody tr:hover {
        background-color: #f3f4f6;
      }
      
      /* 按钮相关样式 */
      .action-buttons {
        display: flex;
        justify-content: center;
        gap: 1rem;
        color: #ef4444;
      }
      .action-btn {
        padding: 0.5rem 1rem;
        border-radius: 0.375rem;
        color: white;
        transition: all 0.2s;
        display: inline-flex;
        align-items: center;
      }
      .action-btn-blue {
        background-color: #3b82f6;
      }
      .action-btn-blue:hover {
        background-color: #2563eb;
      }
      .action-btn-red {
        background-color: #ef4444;
      }
      .action-btn-red:hover {
        background-color: #dc2626;
      }
      .button-group {
        display: flex;
        justify-content: space-between;
        width: 100%;
        margin-bottom: 1rem;
      }
      .left-buttons, 
      .right-buttons {
        display: flex;
        gap: 0.6rem;
      }
      
      /* 表单元素样式 */
      .form-checkbox {
        margin: 0 auto;
        display: block;
        border: 1px solid #e5e7eb;
        border-radius: 0.25rem;
        height: 1.25rem;
        width: 1.25rem;
      }
      .form-input,
      #search-input {
        border: 1px solid #e5e7eb;
        border-radius: 0.375rem;
        padding: 0.5rem 0.75rem;
        height: 2.5rem;
      }
      #search-input {
        width: 300px;
      }
      
      /* 导航和页脚样式 */
      .nav-container {
        background-color: #1e40af;
      }
      .footer {
        background-color: #1e3a8a;
        color: white;
        padding: 1rem;
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        font-size: 0.875rem;
        z-index: 10;
      }
      .footer a {
        color: white;
      }
      .footer a:hover {
        color: #bfdbfe;
      }
      /* 新增样式 */
      .text-link {
        color: #3b82f6;
        text-decoration: none;
        transition: color 0.2s;
      }
      .text-link:hover {
        color: #2563eb;
        text-decoration: underline;
      }
      .cursor-not-allowed {
        cursor: not-allowed;
      }
      .opacity-75 {
        opacity: 0.75;
      }

      /* 响应式调整 */
      @media (max-width: 768px) {
        .button-group {
          flex-direction: column;
          gap: 0.5rem;
        }
        .left-buttons, .right-buttons {
          justify-content: space-between;
          width: 100%;
        }
        #search-input {
          width: 200px;
        }
      }
  </style>
</head>
<body>
  <nav class="nav-container shadow">
    <div class="container mx-auto px-6 py-4 flex justify-between items-center">
      <a href="/" class="action-btn action-btn-blue">
        <i class="fas fa-arrow-left mr-2"></i> 返回首页
      </a>
      <h1 class="text-2xl font-bold text-white text-center">文件管理</h1>
      <div class="relative">
        <input type="search" id="search-input" placeholder="搜索文件" class="pl-3 pr-10 py-2 w-full border rounded-lg">
        <i class="fas fa-search absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
      </div>
    </div>
  </nav>

  <main class="container mx-auto px-6 py-8 max-w-6xl main-container">
    <div class="bg-white p-6 rounded-lg shadow-md">
      <div class="button-group">
        <div class="left-buttons">
          <button id="select-all" class="action-btn action-btn-blue">
            <i class="fas fa-check-square mr-2"></i>全选
          </button>
          <button id="select-reverse" class="action-btn action-btn-blue">
            <i class="fas fa-exchange-alt mr-2"></i>反选
          </button>
        </div>
        <div class="right-buttons">
          <button id="delete-records" class="action-btn action-btn-red">
            <i class="fas fa-trash-alt mr-2"></i>删除记录
          </button>
          <button id="delete-files" class="action-btn action-btn-red">
            <i class="fas fa-trash-alt mr-2"></i>删除文件
          </button>
          <button id="copy-urls" class="action-btn action-btn-blue">
            <i class="fas fa-copy mr-2"></i>复制直链
          </button>
        </div>
      </div>

      <div id="delete-progress-container" class="hidden mt-4">
        <div class="flex justify-between text-sm text-gray-600 mb-1">
          <span>正在删除</span>
          <span id="delete-progress-percent">0%</span>
        </div>
        <div class="h-2 bg-gray-200 rounded-full">
          <div id="delete-progress" class="h-full bg-red-500 rounded-full transition-all duration-300" style="width: 0%"></div>
        </div>
      </div>

      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all-check" class="form-checkbox"></th>
              <th>序号(ID)</th>
              <th>文件名</th>
              <th>文件大小</th>
              <th>上传类型</th>
              <th>上传时间</th>
              <th>页面地址</th>
              <th>直链地址</th>
            </tr>
          </thead>
          <tbody id="file-table-body"></tbody>
        </table>
      </div>

      <div class="flex justify-between items-center mt-6">
        <button id="prev-page" class="action-btn action-btn-blue">上一页</button>
        <span id="page-info">第 1 页</span>
        <button id="next-page" class="action-btn action-btn-blue">下一页</button>
      </div>
    </div>
  </main>

  <footer class="footer text-center">
    ${copyright()}
  </footer>

  <script>
    const bjTime = ${bjTime.toString()};
    const escapeHtml = ${escapeHtml.toString()};
    let currentPage = 1;
    const itemsPerPage = 20;

    async function loadPaginatedFiles(page) {
      try {
        const response = await fetch(\`/api/qry?page=\${page}\`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || '网络响应不正常');
        }
        const files = await response.json();
        console.log('Received files:', files);
        
        if (!Array.isArray(files)) {
          throw new Error('数据格式无效: 需要数组');
        }
        
        renderFiles(files);
        document.getElementById('page-info').textContent = \`第 \${page} 页\`;
        currentPage = page;
      } catch (error) {
        console.error('Error loading files:', error);
        alert('加载文件失败: ' + error.message);
      }
    }

    function renderFiles(files) {
      const tbody = document.getElementById('file-table-body');
      tbody.innerHTML = files.map((file, index) => \`
        <tr>
          <td><input type="checkbox" class="form-checkbox" data-id="\${file.id}"></td>
          <td>\${index + 1}(\${file.id})</td>
          <td>\${escapeHtml(file.filename)}</td>
          <td>\${escapeHtml(file.filesize)}</td>
          <td>\${file.upload_type === 'github' ? 'GitHub' : 'Gist'}</td>
          <td>\${bjTime(file.upload_time)}</td>
          <td><a href="\${escapeHtml(file.page_url)}" target="_blank" class="text-link">查看</a></td>
          <td><a href="\${escapeHtml(file.direct_url)}" target="_blank" class="text-link">查看</a></td>
        </tr>
      \`).join('');
      bindCheckboxEvents();
      updateHeaderCheckbox();
    }

    // 初始化加载第一页
    loadPaginatedFiles(1);

    // 分页按钮事件
    document.getElementById('prev-page').addEventListener('click', () => {
      if (currentPage > 1) loadPaginatedFiles(currentPage - 1);
    });

    document.getElementById('next-page').addEventListener('click', () => {
      loadPaginatedFiles(currentPage + 1);
    });

    // 搜索功能
    document.getElementById('search-input').addEventListener('input', function(e) {
      const searchTerm = e.target.value.toLowerCase();
      const rows = document.querySelectorAll('#file-table-body tr');
      rows.forEach(row => {
        const filename = row.querySelector('td:nth-child(3)').textContent.toLowerCase();
        row.style.display = filename.includes(searchTerm) ? '' : 'none';
      });
    });

    // 全选/反选
    function updateHeaderCheckbox() {
        const dataCheckboxes = document.querySelectorAll('.form-checkbox[data-id]');
        const headerCheckbox = document.getElementById('select-all-check');
        
        // 计算选中状态
        const checkedCount = Array.from(dataCheckboxes).filter(cb => cb.checked).length;
        const allChecked = checkedCount === dataCheckboxes.length && dataCheckboxes.length > 0;
        const someChecked = checkedCount > 0 && !allChecked;

        // 更新表头复选框状态
        headerCheckbox.checked = allChecked;
        headerCheckbox.indeterminate = someChecked;  // 中间状态
    }

    // 表头复选框事件
    document.getElementById('select-all-check').addEventListener('change', function(e) {
        const checkboxes = document.querySelectorAll('.form-checkbox[data-id]');
        checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
    });

    // 全选功能
    document.getElementById('select-all').addEventListener('click', function() {
        const checkboxes = document.querySelectorAll('.form-checkbox[data-id]');
        checkboxes.forEach(checkbox => checkbox.checked = true);
        updateHeaderCheckbox();
    });

    // 反选功能
    document.getElementById('select-reverse').addEventListener('click', function() {
        const checkboxes = document.querySelectorAll('.form-checkbox[data-id]');
        checkboxes.forEach(checkbox => checkbox.checked = !checkbox.checked);
        updateHeaderCheckbox();
    });

    // 初始化时绑定数据行复选框事件
    function bindCheckboxEvents() {
        document.querySelectorAll('.form-checkbox[data-id]').forEach(checkbox => {
            checkbox.addEventListener('change', updateHeaderCheckbox);
        });
    }

  function getSelectedIds() {
    return Array.from(document.querySelectorAll('.form-checkbox[data-id]:checked'))
      .map(checkbox => checkbox.dataset.id)
      .filter(id => id && !isNaN(id));
  }

    // 删除记录（带进度条）
    document.getElementById('delete-records').addEventListener('click', async function () {
      const ids = getSelectedIds();
      if (ids.length === 0) return alert('请选择要删除的记录');
      if (!confirm(\`确定要删除 \${ids.length} 条记录吗？\`)) return;
      const btn = this;
      const progressContainer = document.getElementById('delete-progress-container');
      const progressBar = document.getElementById('delete-progress');
      const progressText = document.getElementById('delete-progress-percent');
      btn.disabled = true;
      progressContainer.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      let successCount = 0;
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
          const res = await fetch(\`/api/rec/\${id}\`, { method: 'DELETE' });
          const result = await res.json();
          if (res.ok && result.success_count > 0) successCount++;
        } catch (err) {
          console.error(\`删除记录失败 [ID: \${id}]\`, err);
        }
        const percent = Math.round(((i + 1) * 100) / ids.length);
        progressBar.style.width = \`\${percent}%\`;
        progressText.textContent = \`\${percent}%\`;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      await new Promise(resolve => setTimeout(resolve, 300)); // 保持100%状态300ms
      setTimeout(() => {
        progressContainer.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = '0%';
      }, 800);
      btn.disabled = false;
      alert(\`成功删除 \${successCount}/\${ids.length} 条记录\`);
      loadPaginatedFiles(currentPage);
    });

    // 批量删除文件（带进度条）
    document.getElementById('delete-files').addEventListener('click', async function () {
      const ids = getSelectedIds();
      if (!ids.length) return alert('请选择要删除的文件');
      if (!confirm(\`即将永久删除 \${ids.length} 个文件 (不可逆)，确定继续？\`)) return;
      const btn = this;
      const progressContainer = document.getElementById('delete-progress-container');
      const progressBar = document.getElementById('delete-progress');
      const progressText = document.getElementById('delete-progress-percent');
      btn.disabled = true;
      progressContainer.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      let successCount = 0;
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
          const res = await fetch(\`/api/del/\${id}\`, { method: 'DELETE' });
          const result = await res.json();
          if (res.ok && result.success_count > 0) successCount++;
        } catch (err) {
          console.error(\`删除失败 [ID: \${id}]\`, err);
        }
        const percent = Math.round(((i + 1) * 100) / ids.length);
        progressBar.style.width = \`\${percent}%\`;
        progressText.textContent = \`\${percent}%\`;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      await new Promise(resolve => setTimeout(resolve, 300));
      setTimeout(() => {
        progressContainer.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = '0%';
      }, 800);
      btn.disabled = false;
      alert(\`成功删除 \${successCount}/\${ids.length} 个文件\`);
      loadPaginatedFiles(currentPage);
    });

    // 批量复制直链
    document.getElementById('copy-urls').addEventListener('click', async function() {
      const btn = this;
      const selectedCheckboxes = document.querySelectorAll('.form-checkbox:checked');
      const urls = [];
      
      selectedCheckboxes.forEach(checkbox => {
        if (checkbox.id === 'select-all-check') return;
        const row = checkbox.closest('tr');
        const directUrl = row.querySelector('td:nth-child(8) a').href;
        urls.push(directUrl);
      });
      if (urls.length === 0) { alert('请选择要复制的文件'); return; }
      
      try {
        await navigator.clipboard.writeText(urls.join('\\n'));
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check mr-2"></i>已复制';
        btn.classList.add('cursor-not-allowed', 'opacity-75');
        alert(\`成功复制 \${urls.length} 个直链\`);
        setTimeout(() => {
          btn.innerHTML = originalHTML;
          btn.classList.remove('cursor-not-allowed', 'opacity-75');
        }, 2000);
      } catch (err) {
        console.error('复制失败:', err);
        alert('复制失败，请手动复制链接');
      }
    });
  </script>
</body>
</html>`;

