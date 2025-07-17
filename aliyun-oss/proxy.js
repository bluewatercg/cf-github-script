// Cloudflare Worker 反代阿里云OSS (最终修复签名问题)
// 完全修复路径编码问题
// 环境变量配置（在Cloudflare Worker中设置）：
// OSS_BUCKET_NAME=your-bucket-name
// OSS_REGION=oss-cn-hongkong
// OSS_ACCESS_KEY_ID=your-access-key-id
// OSS_SECRET_ACCESS_KEY=your-secret-access-key

// CORS配置
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Modified-Since, If-None-Match, Content-Type, Authorization",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Last-Modified, ETag, X-Cache-Status",
  "Access-Control-Max-Age": "86400",
};

// 阿里云OSS签名实现
var encoder = new TextEncoder();

// 从完整URL字符串中提取原始路径（保留编码）
function extractRawPath(urlStr) {
  try {
    const urlObj = new URL(urlStr);
    // 手动提取原始路径部分
    const origin = urlObj.origin;
    const rawPathAndQuery = urlStr.substring(origin.length);
    const pathEndIndex = rawPathAndQuery.indexOf('?');
    
    // 返回路径部分（不包括查询参数）
    return pathEndIndex >= 0 ? rawPathAndQuery.substring(0, pathEndIndex) : rawPathAndQuery;
  } catch (e) {
    console.error("提取原始路径失败:", e);
    return new URL(urlStr).pathname;
  }
}

var AliyunClient = class {
  constructor({ accessKeyId, secretAccessKey, bucketName, region, cache, retries, initRetryMs }) {
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    if (bucketName == null) throw new TypeError("bucketName is a required option");
    if (region == null) throw new TypeError("region is a required option");
    
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucketName = bucketName;
    this.region = region;
    this.cache = cache || new Map();
    this.retries = retries != null ? retries : 10;
    this.initRetryMs = initRetryMs || 50;
  }

  async sign(input, init) {
    if (input instanceof Request) {
      const { method, url, headers, body } = input;
      init = Object.assign({ method, url, headers }, init);
      if (init.body == null && headers.has("Content-Type")) {
        init.body = body != null ? body : await input.clone().arrayBuffer();
      }
      input = url;
    }
    const signer = new AliyunV1Signer(Object.assign({ url: input }, init, this, init && init.aliyun));
    const signed = Object.assign({}, init, await signer.sign());
    delete signed.aliyun;
    try {
      return new Request(signed.url.toString(), signed);
    } catch (e) {
      if (e instanceof TypeError) {
        return new Request(signed.url.toString(), Object.assign({ duplex: "half" }, signed));
      }
      throw e;
    }
  }

  async fetch(input, init) {
    for (let i = 0; i <= this.retries; i++) {
      const fetched = fetch(await this.sign(input, init));
      if (i === this.retries) {
        return fetched;
      }
      const res = await fetched;
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * this.initRetryMs * Math.pow(2, i)));
    }
    throw new Error("An unknown error occurred, ensure retries is not negative");
  }
};

var AliyunV1Signer = class {
  constructor({
    method,
    url,
    headers,
    body,
    accessKeyId,
    secretAccessKey,
    bucketName,
    region,
    cache,
    datetime,
    signQuery,
  }) {
    if (url == null) throw new TypeError("url is a required option");
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    if (bucketName == null) throw new TypeError("bucketName is a required option");
    if (region == null) throw new TypeError("region is a required option");
    
    this.method = method || (body ? "POST" : "GET");
    this.headers = new Headers(headers || {});
    this.body = body;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucketName = bucketName;
    this.region = region;
    this.cache = cache || new Map();
    this.datetime = datetime || new Date().toUTCString();
    this.signQuery = signQuery;
    
    // 保存原始URL字符串
    this.originalUrlStr = url;
    
    // 创建用于签名的URL对象
    this.url = new URL(url);
    this.url.hostname = `${this.bucketName}.${this.region}.aliyuncs.com`;
    
    // 添加必要头部
    this.headers.set("Date", this.datetime);
    this.headers.set("Host", this.url.hostname);
    
    // 从原始URL字符串中提取原始路径（保留编码）
    this.canonicalizedResource = extractRawPath(this.originalUrlStr);
    
    console.log(`签名资源路径: ${this.canonicalizedResource}`);
  }

  getCanonicalizedOSSHeaders() {
    let headers = [];
    for (const [key, value] of this.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith("x-oss-")) {
        headers.push([lowerKey, value.trim()]);
      }
    }
    
    headers.sort((a, b) => a[0].localeCompare(b[0]));
    
    return headers.map(([k, v]) => `${k}:${v}`).join("\n");
  }

  async sign() {
    // 生成待签名字符串
    const stringToSign = this.getStringToSign();
    
    console.log(`待签名字符串: ${stringToSign}`);
    
    // 计算签名
    const signature = await this.calculateSignature(stringToSign);
    
    // 添加Authorization头部
    this.headers.set("Authorization", `OSS ${this.accessKeyId}:${signature}`);
    
    return {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body,
    };
  }

  getStringToSign() {
    return [
      this.method.toUpperCase(),
      this.headers.get("Content-MD5") || "",
      this.headers.get("Content-Type") || "",
      this.headers.get("Date"),
      this.canonicalizedOSSHeaders + (this.canonicalizedOSSHeaders ? "\n" : ""),
      this.canonicalizedResource
    ].join("\n");
  }

  async calculateSignature(stringToSign) {
    // 使用正确的签名算法：HMAC-SHA1 + Base64
    const key = encoder.encode(this.secretAccessKey);
    const data = encoder.encode(stringToSign);
    
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    
    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      data
    );
    
    // 将ArrayBuffer转换为Base64
    return this.arrayBufferToBase64(signature);
  }

  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
};

// 获取缓存设置
function getCacheSettings(env) {
  const cacheTtl = parseInt(env.CACHE_TTL) || 86400;
  const cdnCacheTtl = parseInt(env.CDN_CACHE_TTL) || 2592000;

  return {
    ttl: cacheTtl,
    cdnTtl: cdnCacheTtl,
  };
}

// 判断是否应该缓存请求
function shouldCache(method, url, headers, env) {
  if (env.CACHE_ENABLED === "false") {
    return false;
  }

  if (!["GET", "HEAD"].includes(method)) {
    return false;
  }

  return true;
}

// 生成统一的缓存键
function generateCacheKey(url, method) {
  const cacheUrl = new URL(url);
  cacheUrl.search = "";

  return new Request(cacheUrl.toString(), {
    method: method,
    headers: new Headers(),
  });
}

// 检查是否为下载请求
function isDownloadRequest(url) {
  return url.searchParams.has("response-content-disposition") || 
         url.searchParams.get("response-content-disposition")?.includes("attachment");
}

// 处理下载响应头部
function processDownloadResponse(response, originalUrl) {
  if (!isDownloadRequest(originalUrl)) {
    return response;
  }

  if (response.headers.has("Content-Disposition")) {
    return response;
  }

  const contentDisposition = originalUrl.searchParams.get("response-content-disposition");
  if (contentDisposition) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Content-Disposition", decodeURIComponent(contentDisposition));

    const responseContentType = originalUrl.searchParams.get("response-content-type");
    if (responseContentType && !response.headers.get("Content-Type")) {
      newHeaders.set("Content-Type", decodeURIComponent(responseContentType));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  return response;
}

// 验证请求来源（防盗链）
function validateReferer(request, env) {
  if (!env.ALLOWED_REFERERS) {
    return true;
  }

  const referer = request.headers.get("Referer");
  if (!referer) {
    return true;
  }

  const allowedReferers = env.ALLOWED_REFERERS.split(",").map((r) => r.trim());
  const refererOrigin = new URL(referer).origin;
  const isAllowed = allowedReferers.some((allowed) => refererOrigin === allowed || refererOrigin.endsWith(allowed.replace("https://", "")));

  if (!isAllowed) {
    console.log(`拒绝访问：不允许的来源 ${refererOrigin}`);
    return false;
  }

  return true;
}

// 添加CORS头部到响应
function addCorsHeaders(response, cacheStatus = "MISS") {
  const newResponse = new Response(response.body, response);

  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });

  newResponse.headers.set("X-Cache-Status", cacheStatus);
  newResponse.headers.set("X-Served-By", "Cloudflare-Worker");

  return newResponse;
}

// 处理OPTIONS预检请求
function handleOptions() {
  return new Response(null, {
    status: 200,
    headers: CORS_HEADERS,
  });
}

// 构建阿里云OSS URL
function buildOssUrl(originalUrlStr, env) {
  const urlObj = new URL(originalUrlStr);
  // 保留原始路径和查询参数
  const rawPathAndQuery = originalUrlStr.substring(urlObj.origin.length);
  return `https://${env.OSS_BUCKET_NAME}.${env.OSS_REGION}.aliyuncs.com${rawPathAndQuery}`;
}

// 使用阿里云签名发送请求到OSS
async function signAndFetchFromOss(request, env) {
  const originalUrlStr = request.url;
  const ossUrl = buildOssUrl(originalUrlStr, env);

  console.log(`代理请求到OSS: ${ossUrl}`);

  // 创建阿里云客户端
  const ossClient = new AliyunClient({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    secretAccessKey: env.OSS_SECRET_ACCESS_KEY,
    bucketName: env.OSS_BUCKET_NAME,
    region: env.OSS_REGION,
  });

  // 过滤请求头部
  const filteredHeaders = filterHeaders(request.headers, env);

  // 使用签名
  const signedRequest = await ossClient.sign(ossUrl, {
    method: request.method,
    headers: filteredHeaders,
    body: request.body,
  });

  // 发送已签名的请求
  const response = await fetch(signedRequest);

  console.log(`OSS响应状态: ${response.status} ${response.statusText}`);
  if (!response.ok) {
    const errorResponse = response.clone();
    const errorText = await errorResponse.text();
    console.log(`OSS错误响应: ${errorText}`);
  }

  return response;
}

// 过滤请求头部
function filterHeaders(headers, env) {
  const filteredHeaders = new Headers();

  const allowedHeaders = [
    "range",
    "if-modified-since",
    "if-none-match",
    "if-match",
    "content-type",
    "content-length",
    "cache-control",
  ];

  if (env.ALLOWED_HEADERS) {
    const customHeaders = env.ALLOWED_HEADERS.split(",").map((h) => h.trim().toLowerCase());
    allowedHeaders.push(...customHeaders);
  }

  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (allowedHeaders.includes(lowerKey)) {
      filteredHeaders.set(key, value);
    }
  }

  return filteredHeaders;
}

// 处理缓存请求
async function handleCachedRequest(request, originalUrl, env, ctx) {
  const cache = caches.default;
  const cacheKey = generateCacheKey(originalUrl, request.method);
  let cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    console.log(`缓存命中: ${originalUrl.pathname}`);
    const processedResponse = processDownloadResponse(cachedResponse, originalUrl);
    return addCorsHeaders(processedResponse, "HIT");
  }

  console.log(`缓存未命中，处理请求到OSS: ${originalUrl.pathname}`);
  let response = await signAndFetchFromOss(request, env);

  if (response.ok && shouldCache(request.method, originalUrl, request.headers, env)) {
    const cacheSettings = getCacheSettings(env);
    const cacheTtl = cacheSettings.ttl;
    const cdnCacheTtl = cacheSettings.cdnTtl;

    const headersToCache = new Headers(response.headers);
    headersToCache.delete("Content-Disposition");
    headersToCache.set("Cache-Control", `public, max-age=${cacheTtl}`);
    headersToCache.set("CDN-Cache-Control", `public, max-age=${cdnCacheTtl}`);
    headersToCache.set("X-Cache-Time", new Date().toISOString());

    const responseToCache = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headersToCache,
    });

    ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
    const processedResponse = processDownloadResponse(responseToCache, originalUrl);
    return addCorsHeaders(processedResponse, "MISS");
  }

  const processedResponse = processDownloadResponse(response, originalUrl);
  return addCorsHeaders(processedResponse, "BYPASS");
}

// 主要的Worker处理逻辑
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response(
        JSON.stringify({
          error: "方法不允许",
          message: "只支持GET和HEAD请求",
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        }
      );
    }

    try {
      const originalUrl = new URL(request.url);
      console.log(`处理请求: ${originalUrl.pathname}`);

      if (!validateReferer(request, env)) {
        return new Response(
          JSON.stringify({
            error: "访问被拒绝",
            message: "不允许的来源域名",
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              ...CORS_HEADERS,
            },
          }
        );
      }

      if (shouldCache(request.method, originalUrl, request.headers, env)) {
        return await handleCachedRequest(request, originalUrl, env, ctx);
      } else {
        console.log(`直接转发（不缓存）: ${originalUrl.pathname}`);
        const response = await signAndFetchFromOss(request, env);
        const processedResponse = processDownloadResponse(response, originalUrl);
        return addCorsHeaders(processedResponse, "BYPASS");
      }
    } catch (error) {
      console.error("代理请求失败:", error);

      return new Response(
        JSON.stringify({
          error: "代理请求失败",
          message: error.message,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        }
      );
    }
  },
};
