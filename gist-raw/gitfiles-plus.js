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

// ========== 初始化数据库 ==========
async function initializeDatabase(db) {
  const table_schema = `
    CREATE TABLE IF NOT EXISTS git_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL, 
      filesize INTEGER NOT NULL,
      upload_type TEXT NOT NULL CHECK (upload_type IN ('gist', 'github')),
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      gist_id TEXT,
      github_username TEXT,
      github_repo TEXT,
      github_branch TEXT DEFAULT 'main',
      github_path TEXT DEFAULT '/',
      page_url TEXT,
      direct_url TEXT
    )
  `;
  try {
    await db.prepare(table_schema).run();
  } catch (error) {
    console.error('数据库初始化失败:', error.message);
    throw error;
  }
}

// Github API 请求头
function getGitHubHeaders(env) {
  return {
    'Authorization': `token ${env.GH_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Cloudflare-Worker-Github',
  };
}

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
async function buildDirectUrl(uploadType, username, idORrepo, branch, path, filename, env, event) {
  const filePath = path ? `${cleanPath(path)}/${filename}` : filename;
  
  if (uploadType === 'gist') {
    return `https://gist.githubusercontent.com/${username}/${idORrepo}/raw/${filename}`;
  }
  const isPrivate = await checkRepoIsPrivate(username, idORrepo, env, event);   
  return isPrivate && env.RAW_DOMAIN
    ? `https://${env.RAW_DOMAIN}/${username}/${idORrepo}/${branch}/${filePath}`
    : `https://github.com/${username}/${idORrepo}/raw/${branch}/${filePath}`; 
}

// 检查仓库是否为私有（带缓存）
async function checkRepoIsPrivate(username, repo, env, event) {  
  const cacheKey = new Request(`https://gitcache.example.com/repo_privacy/${username}/${repo}`); 
  const cache = caches.default;
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
      headers: getGitHubHeaders(env) 
    });
    if (!response.ok) return false;
    
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
  } catch (error) { return false; }  
}

export default {
  async fetch(request, env, event) {
    const { pathname, searchParams } = new URL(request.url);    
    await initializeDatabase(env.GH_DB);
    const routes = {
      '/': () => htmlResponse(HTML, corsHeaders()),
      '/list': () => htmlResponse(listHTML, corsHeaders()),
      '/api/upload': () => handleUpload(request, env, corsHeaders(), event),
      '/api/qry': () => handleFileQuery(env, searchParams, corsHeaders()),
      '/api/rec/(\\d+)': (req, id) => handleDeleteRecord(id, env, corsHeaders(), req)
    };

    for (const [path, handler] of Object.entries(routes)) {
      const match = pathname.match(new RegExp(`^${path}$`));
      if (match) return await handler(request, ...match.slice(1));
    }
    return jsonResponse({ error: '不存在' }, 404, corsHeaders()); 
  }
};


// ========== 上传请求 ==========
async function handleUpload(request, env, corsHeaders, event) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: '不支持该请求方式' }, 405, corsHeaders);
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll('files');
    if (!files.length) return jsonResponse({ error: '未选择任何文件' }, 400, corsHeaders);

    const results = await Promise.all(
      files.map(async file => {
        const fileData = await processSingleFile(file, formData, env, event);
        await saveToDatabase(fileData, env.GH_DB);
        return fileData;
      })
    );

    return jsonResponse(results, 201, corsHeaders);
  } catch (err) {
    return jsonResponse({ 
      error: err.message
    }, 500, corsHeaders);
  }
}

// ========== 单文件处理 ==========
async function processSingleFile(file, formData, env, event) {
  const fileData = {
    filename: file.name,
    filesize: formatSize(file.size),
    upload_type: formData.get('upload-type'),
    upload_time: new Date().toISOString()
  };

  if (fileData.upload_type === 'gist') {
    await processGist(file, formData, fileData, env);
  } else {
    await processGitHub(file, formData, fileData, env, event);
  }
  if (fileData.direct_url instanceof Promise) {
    fileData.direct_url = await fileData.direct_url;
  }
  return fileData;
}

// ========== Gist处理 ==========
async function processGist(file, formData, fileData, env) {
  const isPublic = formData.get('gist-public') === 'on';
  const existingGistId = formData.get('existing-gist')?.trim();
  const content = await file.text();
  const gistUrl = existingGistId 
    ? `https://api.github.com/gists/${existingGistId}`
    : 'https://api.github.com/gists';

  const response = await fetch(gistUrl, {
    method: existingGistId ? 'PATCH' : 'POST',
    headers: getGitHubHeaders(env),
    body: JSON.stringify({
      public: isPublic,
      files: { [file.name]: { content } }
    }),
  });

  if (!response.ok) throw new Error(`Gist API 错误: ${await response.text()}`);
  
  const gist = await response.json();
  if (!gist.owner?.login) throw new Error('Gist 缺少用户名信息');

  fileData.page_url = gist.html_url;
  fileData.direct_url = buildDirectUrl('gist', gist.owner.login, gist.id, '', '', file.name);
  fileData.gist_id = gist.id;
}

// ========== Github处理 ==========
async function processGitHub(file, formData, fileData, env, event) {
  const username = formData.get('gh-username')?.trim();
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

  // 获取已有文件的SHA
  let sha;
  try {
    const shaRes = await fetch(apiUrl, { 
      headers: getGitHubHeaders(env)
    });

    if (shaRes.status === 401) throw new Error('Token 无效或权限不足');
    if (shaRes.status === 404) console.log('文件不存在，将创建新记录');
    if (shaRes.ok) {
      const data = await shaRes.json();
      sha = data.sha;
    }
  } catch (error) {
    console.error('SHA 获取失败:', error);
    throw error;
  }

  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: getGitHubHeaders(env),
    body: JSON.stringify({
      message: `Git-Files upload: ${file.name}`,
      content,
      branch,
      ...(sha && { sha })
    }),
  });

  if (!response.ok) throw new Error(`GitHub API 错误: ${await response.text()}`);

  const pagePath = cleanPathStr ? `${cleanPathStr}/${file.name}` : file.name;
  fileData.github_username = username;
  fileData.github_repo = repo;
  fileData.github_branch = branch;
  fileData.github_path = cleanPathStr;
  fileData.page_url = `https://github.com/${username}/${repo}/blob/${branch}/${pagePath}`;
  fileData.direct_url = await buildDirectUrl('github', username, repo, branch, cleanPathStr, file.name, env, event);
}

// 数据库操作
async function saveToDatabase(data, db) {
  const { 
    filename, filesize, upload_type, upload_time,
    gist_id, github_username, github_repo,
    github_branch, github_path, page_url, direct_url 
  } = data;

  await db.prepare(`
    INSERT INTO git_files (
      filename, filesize, upload_type, upload_time,
      gist_id, github_username, github_repo,
      github_branch, github_path, page_url, direct_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    filename || '',
    filesize || '',
    upload_type || '',
    upload_time || '',
    gist_id ?? null,
    github_username ?? null,
    github_repo ?? null,
    github_branch || 'main',
    github_path || '/',
    page_url || '',
    direct_url || ''
  ).run();
}

// 文件查询
async function handleFileQuery(env, params, corsHeaders) {
  const page = parseInt(params.get('page')) || 1;
  const limit = 20;
  const result = await env.GH_DB.prepare(`
    SELECT id, filename, filesize, upload_type,
           upload_time, page_url, direct_url
    FROM git_files
    ORDER BY upload_time DESC
    LIMIT ? OFFSET ?
  `).bind(limit, (page - 1) * limit).all();
  
  return jsonResponse(result.results || result.rows || [], 200, corsHeaders);
}

// 删除数据库记录
async function handleDeleteRecord(id, env, corsHeaders, request) {
  if (request.method !== 'DELETE') {
    return jsonResponse({ error: '不支持的请求方式' }, 405, corsHeaders);
  }

  try {
    const result = await env.GH_DB.prepare(`
      DELETE FROM git_files WHERE id = ?
    `).bind(id).run();

    return result.success
      ? jsonResponse({ success: true, id }, 200, corsHeaders)
      : jsonResponse({ error: '数据库更新失败' }, 500, corsHeaders);
  } catch (err) {
    return jsonResponse({
      error: `Delete failed: ${err.message}`
    }, 500, corsHeaders);
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

// HTML版权页
function copyright() {
  return `
    <p class="mb-0">
      <span class="item">Copyright © 2025 Yutian81</span>
      <span class="separator mx-2">|</span>
      <a href="https://github.com/yutian81/slink/" class="item text-blue-600 hover:text-blue-800" target="_blank">
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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub 文件服务器</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📁</text></svg>" type="image/svg+xml">
  <link href="https://unpkg.com/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
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
            <div id="progress" class="h-full bg-blue-500 rounded-full" style="width: 0%"></div>
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
          <div><label class="form-label">用户名*</label><input type="text" id="gh-username" class="form-input" required placeholder="必须"></div>
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
        formData.append('gh-username', document.getElementById('gh-username').value);
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
        xhr.open('POST', '/api/upload', true);
        
        xhr.upload.onprogress = function(e) {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded * 100) / e.total);
            document.getElementById('progress').style.width = percentComplete + '%';
            progressPercent.textContent = percentComplete + '%';
          }
        };
        
        xhr.onload = function() {
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
        };
        
        xhr.onerror = function() {
          throw new Error('网络错误');
        };
        xhr.send(formData);
      } catch (error) {
        alert(\`错误：\${error.message}\`);
        progressContainer.classList.add('hidden');
      } finally {
        uploadBtn.disabled = false;
      }
    });

    function escapeHtml(unsafe) {
      if (!unsafe) return '';
      return unsafe.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function showUploadResults(results) {
      const bjTime = ${bjTime.toString()};
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

const listHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文件管理</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📁</text></svg>" type="image/svg+xml">
  <link href="https://unpkg.com/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
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
        gap: 0.5rem;
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
          <button id="copy-urls" class="action-btn action-btn-blue">
            <i class="fas fa-copy mr-2"></i>复制直链
          </button>
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
    // 分页状态
    let currentPage = 1;
    const itemsPerPage = 20;
    async function loadPaginatedFiles(page) {
      try {
        const response = await fetch(\`/api/qry?page=\${page}\`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Network response was not ok');
        }
        const files = await response.json();
        console.log('Received files:', files);
        
        if (!Array.isArray(files)) {
          throw new Error('Invalid data format: expected array');
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
      const bjTime = ${bjTime.toString()};
      const tbody = document.getElementById('file-table-body');
      tbody.innerHTML = files.map((file, index) => \`
        <tr>
          <td><input type="checkbox" class="form-checkbox" data-id="\${file.id}"></td>
          <td>\${index + 1}(\${file.id})</td>
          <td>\${file.filename}</td>
          <td>\${file.filesize}</td>
          <td>\${file.upload_type === 'github' ? 'GitHub' : 'Gist'}</td>
          <td>\${bjTime(file.upload_time)}</td>
          <td><a href="\${file.page_url}" target="_blank" class="text-link">查看</a></td>
          <td><a href="\${file.direct_url}" target="_blank" class="text-link">查看</a></td>
        </tr>
      \`).join('');
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
    document.getElementById('select-all-check').addEventListener('change', function(e) {
      const checkboxes = document.querySelectorAll('.form-checkbox');
      checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
    });

    document.getElementById('select-all').addEventListener('click', function() {
      const checkboxes = document.querySelectorAll('.form-checkbox');
      checkboxes.forEach(checkbox => checkbox.checked = true);
    });

    document.getElementById('select-reverse').addEventListener('click', function() {
      const checkboxes = document.querySelectorAll('.form-checkbox');
      checkboxes.forEach(checkbox => checkbox.checked = !checkbox.checked);
    });

    function getSelectedIds() {
      return Array.from(document.querySelectorAll('.form-checkbox:checked'))
        .map(checkbox => checkbox.dataset.id)
        .filter(id => id);
    }

    // 批量删除记录
    document.getElementById('delete-records').addEventListener('click', async function() {
      const ids = getSelectedIds();
      if (ids.length === 0) return alert('请选择要删除的记录');
      if (!confirm(\`确定要删除 \${ids.length} 条记录吗？\`)) return;
      try {
        const results = await Promise.allSettled(
          ids.map(id => fetch(\`/api/rec/\${id}\`, {
            method: 'DELETE'
          }))
        );
        
        const failedDeletes = results.filter(r => !r.value || !r.value.ok);
        if (failedDeletes.length > 0) {
          throw new Error(\`\${failedDeletes.length}条记录删除失败\`);
        }
        
        alert('成功删除选中记录');
        loadPaginatedFiles(currentPage);
      } catch (error) {
        alert('删除失败: ' + error.message);
      }
    });

    // 批量复制直链
    document.getElementById('copy-urls').addEventListener('click', function() {
      const selectedCheckboxes = document.querySelectorAll('.form-checkbox:checked');
      const urls = [];
      
      selectedCheckboxes.forEach(checkbox => {
        const row = checkbox.closest('tr');
        const directUrl = row.querySelector('td:nth-child(8) a').href;
        urls.push(directUrl);
      });
      
      if (urls.length === 0) return alert('请选择要复制的文件');
      navigator.clipboard.writeText(urls.join('\\n'));
      alert(\`已复制 \${urls.length} 个直链\`);
    });
  </script>
</body>
</html>`;
