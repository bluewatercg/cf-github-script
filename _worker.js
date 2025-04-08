// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 前端页面路由
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // API路由
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      try {
        const formData = await request.formData();
        const files = formData.getAll('files');
        const gistData = {};

        // 处理上传文件
        for (const file of files) {
          const content = await file.text();
          gistData[file.name] = { content };
        }

        // 调用GitHub API
        const response = await fetch(
          env.GIST_ID 
            ? `https://api.github.com/gists/${env.GIST_ID}`
            : 'https://api.github.com/gists',
          {
            method: env.GIST_ID ? 'PATCH' : 'POST',
            headers: {
              'Authorization': `token ${env.GIST_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              public: false,
              files: gistData
            })
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message);
        }

        const result = await response.json();
        return new Response(JSON.stringify({
          id: result.id,
          files: Object.keys(gistData),
          url: result.html_url
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 前端HTML模板
const HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Gist Uploader</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
    .dropzone { 
      border: 2px dashed #ccc; padding: 20px; text-align: center; margin: 20px 0;
      border-radius: 5px; background: #f9f9f9; cursor: pointer;
    }
    #file-list { margin: 10px 0; }
    .file-item { padding: 5px; border-bottom: 1px solid #eee; }
    button { 
      background: #238636; color: white; border: none; padding: 10px 15px;
      border-radius: 5px; cursor: pointer; font-size: 16px;
    }
    #result { margin-top: 20px; padding: 10px; border-radius: 5px; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <h1>Upload Files to Gist</h1>
  <div class="dropzone" id="dropzone">
    <p>Drag & drop files here or click to select</p>
    <input type="file" id="file-input" multiple style="display: none;">
  </div>
  <div id="file-list"></div>
  <button id="upload-btn">Upload to Gist</button>
  <div id="result"></div>

  <script>
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const fileList = document.getElementById('file-list');
    const uploadBtn = document.getElementById('upload-btn');
    const resultDiv = document.getElementById('result');
    let files = [];

    // 处理文件选择
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFiles);
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#238636';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = '#ccc';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '#ccc';
      handleFiles({ target: { files: e.dataTransfer.files } });
    });

    // 上传逻辑
    uploadBtn.addEventListener('click', async () => {
      if (files.length === 0) {
        showResult('Please select at least one file', 'error');
        return;
      }

      try {
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';
        
        const formData = new FormData();
        files.forEach(file => formData.append('files', file));

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        showResult(
          \`Upload successful! <a href="\${data.url}" target="_blank">View Gist</a>\n
          Files: \${data.files.join(', ')}\`,
          'success'
        );
      } catch (err) {
        showResult(\`Error: \${err.message}\`, 'error');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload to Gist';
      }
    });

    // 辅助函数
    function handleFiles(e) {
      files = Array.from(e.target.files);
      fileList.innerHTML = files.map(file => 
        \`<div class="file-item">\${file.name} (\${formatSize(file.size)})</div>\`
      ).join('');
    }

    function showResult(message, type) {
      resultDiv.className = type;
      resultDiv.innerHTML = message;
    }

    function formatSize(bytes) {
      if (bytes < 1024) return \`\${bytes} bytes\`;
      if (bytes < 1048576) return \`\${(bytes / 1024).toFixed(1)} KB\`;
      return \`\${(bytes / 1048576).toFixed(1)} MB\`;
    }
  </script>
</body>
</html>
`;
