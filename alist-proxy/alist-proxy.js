// src/const.js
let ADDRESS, TOKEN, WORKER_ADDRESS, DISABLE_SIGN;

// 从环境变量初始化常量
function initConstants(env) {
  // OpenList 后端服务器地址 (不要包含尾随斜杠)
  ADDRESS = env.ADDRESS || "YOUR_ADDRESS";
  // OpenList 服务器的 API 访问令牌 (密钥)
  TOKEN = env.TOKEN || "YOUR_TOKEN";
  // Cloudflare Worker 的完整地址
  WORKER_ADDRESS = env.WORKER_ADDRESS || "YOUR_WORKER_ADDRESS";
  // 是否禁用签名验证 (推荐设置为 false)
  // 隐私警告：关闭签名会造成文件可被任何知晓路径的人获取
  DISABLE_SIGN =
    env.DISABLE_SIGN === "true" || env.DISABLE_SIGN === true || false;
}

// src/verify.js
// 验证带过期检查的签名字符串
var verify = async (data, _sign) => {
  // If signature verification is disabled, return pass directly
  if (DISABLE_SIGN) {
    return "";
  }

  const signSlice = _sign.split(":");
  if (!signSlice[signSlice.length - 1]) {
    return "expire missing";
  }
  const expire = parseInt(signSlice[signSlice.length - 1]);
  if (isNaN(expire)) {
    return "expire invalid";
  }
  if (expire < Date.now() / 1e3 && expire > 0) {
    return "expire expired";
  }
  const right = await hmacSha256Sign(data, expire);
  if (_sign !== right) {
    return "sign mismatch";
  }
  return "";
};

// 生成过期的HMAC-SHA256签名
var hmacSha256Sign = async (data, expire) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const buf = await crypto.subtle.sign(
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    key,
    new TextEncoder().encode(`${data}:${expire}`)
  );
  return (
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_") +
    ":" +
    expire
  );
};

// src/handleDownload.js
// 使用签名验证和CORS处理下载请求
async function handleDownload(request) {
  const origin = request.headers.get("origin") ?? "*";
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);

  // 如果没有禁用签名验证，则执行验证
  if (!DISABLE_SIGN) {
    const sign = url.searchParams.get("sign") ?? "";
    const verifyResult = await verify(path, sign);
    if (verifyResult !== "") {
      const resp2 = new Response(
        JSON.stringify({
          code: 401,
          message: verifyResult,
        }),
        {
          headers: {
            "content-type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": origin,
          },
        }
      );
      return resp2;
    }
  }

  let resp = await fetch(`${ADDRESS}/api/fs/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      Authorization: TOKEN,
    },
    body: JSON.stringify({
      path,
    }),
  });

  let res = await resp.json();
  if (res.code !== 200) {
    return new Response(JSON.stringify(res));
  }
  request = new Request(res.data.url, request);
  if (res.data.header) {
    for (const k in res.data.header) {
      for (const v of res.data.header[k]) {
        request.headers.set(k, v);
      }
    }
  }

  let response = await fetch(request);
  while (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location) {
      if (location.startsWith(`${WORKER_ADDRESS}/`)) {
        request = new Request(location, request);
        return await handleRequest(request);
      } else {
        request = new Request(location, request);
        response = await fetch(request);
      }
    } else {
      break;
    }
  }
  response = new Response(response.body, response);

  // ====================== 浏览器预览而不下载 start ======================
  // 1. 修正 Content-Disposition
  const contentDisposition = response.headers.get("Content-Disposition");
  if (contentDisposition && contentDisposition.startsWith("attachment")) {
    const newContentDisposition = contentDisposition.replace(/^attachment/, "inline");
    response.headers.set("Content-Disposition", newContentDisposition);
  }

  // 2. 修正 Content-Type
  const contentType = response.headers.get("Content-Type");
  if (contentType && contentType.includes("application/octet-stream")) {
    const correctMimeType = getMimeType(path);
    if (correctMimeType) {
      response.headers.set("Content-Type", correctMimeType);
    }
  }
  // ====================== 浏览器预览而不下载 END ========================

  response.headers.delete("set-cookie");
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.append("Vary", "Origin");
  return response;
}

// 根据文件名后缀获取正确的 MIME 类型。
function getMimeType(filename) {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const mimeTypes = {
    // 图片
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "bmp": "image/bmp",
    "avif": "image/avif",
    // 视频
    "mp4": "video/mp4",
    "webm": "video/webm",
    "ogg": "video/ogg",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    // 音频
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    // 文档
    "pdf": "application/pdf",
    "txt": "text/plain",
    "html": "text/html",
    "css": "text/css",
    "js": "application/javascript",
    "json": "application/json"
  };
  return mimeTypes[extension] || null;
}

// src/handleOptions.js
// 处理预检CORS（OPTIONS）请求
function handleOptions(request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };

  let headers = request.headers;
  if (
    headers.get("Origin") !== null &&
    headers.get("Access-Control-Request-Method") !== null
  ) {
    let respHeaders = {
      ...corsHeaders,
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") || "",
    };
    return new Response(null, {
      headers: respHeaders,
    });
  } else {
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, OPTIONS",
      },
    });
  }
}

// src/handleRequest.js
// 基于HTTP方法路由的主请求处理程序
async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }
  return await handleDownload(request);
}

// src/index.js
// Cloudflare Worker 入口
var src_default = {
  async fetch(request, env, ctx) {
    // 从环境变量初始化常量
    initConstants(env);
    return await handleRequest(request);
  },
};

export { src_default as default };
