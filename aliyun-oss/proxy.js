// Cloudflare Worker 反代阿里云OSS
// 替代自定义域名，提供缓存加速和CORS支持
// Worker透明代理到阿里云OSS，添加缓存和CORS
//
//
// 环境变量配置（在Cloudflare Worker中设置）：
// OSS_BUCKET_NAME=my-bucket  // 必需：阿里云OSS存储桶名称
// OSS_REGION=oss-cn-hangzhou  // 必需：阿里云OSS区域
// OSS_ACCESS_KEY_ID=LTAIxxxxx  // 必需：阿里云OSS访问密钥ID
// OSS_SECRET_ACCESS_KEY=xxxxxxxx  // 必需：阿里云OSS秘密访问密钥
//
// 缓存控制（可选）：
// CACHE_ENABLED=true  // 是否启用缓存（默认true）
// CACHE_TTL=86400  // Worker缓存时间（秒，默认24小时）
// CDN_CACHE_TTL=2592000  // CDN边缘缓存时间（秒，默认30天）
//
// 安全控制（可选）：
// ALLOWED_REFERERS=https://yourdomain.com  // 允许的来源域名（防盗链）
//
// 其他配置（可选）：
// ALLOWED_HEADERS=content-type,range  // 自定义允许的请求头

// CORS配置
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Modified-Since, If-None-Match, Content-Type, Authorization",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Last-Modified, ETag, X-Cache-Status",
  "Access-Control-Max-Age": "86400",
};

// AWS4Fetch实现
var encoder = new TextEncoder();
var UNSIGNABLE_HEADERS = new Set(["authorization", "content-type", "content-length", "user-agent", "presigned-expires", "expect", "x-amzn-trace-id", "range", "connection"]);

var AwsClient = class {
  constructor({ accessKeyId, secretAccessKey, sessionToken, service, region, cache, retries, initRetryMs }) {
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.service = service;
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
        init.body = body != null && headers.has("X-Amz-Content-Sha256") ? body : await input.clone().arrayBuffer();
      }
      input = url;
    }
    const signer = new AwsV4Signer(Object.assign({ url: input }, init, this, init && init.aws));
    const signed = Object.assign({}, init, await signer.sign());
    delete signed.aws;
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

var AwsV4Signer = class {
  constructor({
    method,
    url,
    headers,
    body,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service,
    region,
    cache,
    datetime,
    signQuery,
    appendSessionToken,
    allHeaders,
    singleEncode,
  }) {
    if (url == null) throw new TypeError("url is a required option");
    if (accessKeyId == null) throw new TypeError("accessKeyId is a required option");
    if (secretAccessKey == null) throw new TypeError("secretAccessKey is a required option");
    this.method = method || (body ? "POST" : "GET");
    this.url = new URL(url);
    this.headers = new Headers(headers || {});
    this.body = body;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    let guessedService, guessedRegion;
    if (!service || !region) {
      [guessedService, guessedRegion] = guessServiceRegion(this.url, this.headers);
    }
    this.service = service || guessedService || "";
    this.region = region || guessedRegion || "us-east-1";
    this.cache = cache || new Map();
    this.datetime = datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    this.signQuery = signQuery;
    this.appendSessionToken = appendSessionToken || this.service === "iotdevicegateway";
    this.headers.delete("Host");
    if (this.service === "s3" && !this.signQuery && !this.headers.has("X-Amz-Content-Sha256")) {
      this.headers.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
    }
    const params = this.signQuery ? this.url.searchParams : this.headers;
    params.set("X-Amz-Date", this.datetime);
    if (this.sessionToken && !this.appendSessionToken) {
      params.set("X-Amz-Security-Token", this.sessionToken);
    }
    this.signableHeaders = ["host", ...this.headers.keys()].filter((header) => allHeaders || !UNSIGNABLE_HEADERS.has(header)).sort();
    this.signedHeaders = this.signableHeaders.join(";");
    this.canonicalHeaders = this.signableHeaders
      .map((header) => header + ":" + (header === "host" ? this.url.host : (this.headers.get(header) || "").replace(/\s+/g, " ")))
      .join("\n");
    this.credentialString = [this.datetime.slice(0, 8), this.region, this.service, "aws4_request"].join("/");
    if (this.signQuery) {
      if (this.service === "s3" && !params.has("X-Amz-Expires")) {
        params.set("X-Amz-Expires", "86400");
      }
      params.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
      params.set("X-Amz-Credential", this.accessKeyId + "/" + this.credentialString);
      params.set("X-Amz-SignedHeaders", this.signedHeaders);
    }
    if (this.service === "s3") {
      try {
        this.encodedPath = decodeURIComponent(this.url.pathname.replace(/\+/g, " "));
      } catch (e) {
        this.encodedPath = this.url.pathname;
      }
    } else {
      this.encodedPath = this.url.pathname.replace(/\/+/g, "/");
    }
    if (!singleEncode) {
      this.encodedPath = encodeURIComponent(this.encodedPath).replace(/%2F/g, "/");
    }
    this.encodedPath = encodeRfc3986(this.encodedPath);
    const seenKeys = new Set();
    this.encodedSearch = [...this.url.searchParams]
      .filter(([k]) => {
        if (!k) return false;
        if (this.service === "s3") {
          if (seenKeys.has(k)) return false;
          seenKeys.add(k);
        }
        return true;
      })
      .map((pair) => pair.map((p) => encodeRfc3986(encodeURIComponent(p))))
      .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
      .map((pair) => pair.join("="))
      .join("&");
  }

  async sign() {
    if (this.signQuery) {
      this.url.searchParams.set("X-Amz-Signature", await this.signature());
      if (this.sessionToken && this.appendSessionToken) {
        this.url.searchParams.set("X-Amz-Security-Token", this.sessionToken);
      }
    } else {
      this.headers.set("Authorization", await this.authHeader());
    }
    return {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body,
    };
  }

  async authHeader() {
    return ["AWS4-HMAC-SHA256 Credential=" + this.accessKeyId + "/" + this.credentialString, "SignedHeaders=" + this.signedHeaders, "Signature=" + (await this.signature())].join(
      ", "
    );
  }

  async signature() {
    const date = this.datetime.slice(0, 8);
    const cacheKey = [this.secretAccessKey, date, this.region, this.service].join();
    let kCredentials = this.cache.get(cacheKey);
    if (!kCredentials) {
      const kDate = await hmac("AWS4" + this.secretAccessKey, date);
      const kRegion = await hmac(kDate, this.region);
      const kService = await hmac(kRegion, this.service);
      kCredentials = await hmac(kService, "aws4_request");
      this.cache.set(cacheKey, kCredentials);
    }
    return buf2hex(await hmac(kCredentials, await this.stringToSign()));
  }

  async stringToSign() {
    return ["AWS4-HMAC-SHA256", this.datetime, this.credentialString, buf2hex(await hash(await this.canonicalString()))].join("\n");
  }

  async canonicalString() {
    return [this.method.toUpperCase(), this.encodedPath, this.encodedSearch, this.canonicalHeaders + "\n", this.signedHeaders, await this.hexBodyHash()].join("\n");
  }

  async hexBodyHash() {
    let hashHeader = this.headers.get("X-Amz-Content-Sha256") || (this.service === "s3" && this.signQuery ? "UNSIGNED-PAYLOAD" : null);
    if (hashHeader == null) {
      if (this.body && typeof this.body !== "string" && !("byteLength" in this.body)) {
        throw new Error("body must be a string, ArrayBuffer or ArrayBufferView, unless you include the X-Amz-Content-Sha256 header");
      }
      hashHeader = buf2hex(await hash(this.body || ""));
    }
    return hashHeader;
  }
};

async function hmac(key, string) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(string));
}

async function hash(content) {
  return crypto.subtle.digest("SHA-256", typeof content === "string" ? encoder.encode(content) : content);
}

function buf2hex(buffer) {
  return Array.prototype.map.call(new Uint8Array(buffer), (x) => ("0" + x.toString(16)).slice(-2)).join("");
}

function encodeRfc3986(urlEncodedStr) {
  return urlEncodedStr.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function guessServiceRegion(url, headers) {
  const { hostname, pathname } = url;

  // 阿里云OSS域名识别
  if (hostname.endsWith(".aliyuncs.com")) {
    const match = hostname.match(/^([^.]+)\.([^.]+)\.aliyuncs\.com$/);
    return match != null ? ["s3", match[2]] : ["s3", "oss-cn-hangzhou"];
  }

  // Cloudflare R2
  if (hostname.endsWith(".r2.cloudflarestorage.com")) {
    return ["s3", "auto"];
  }

  // Backblaze B2
  if (hostname.endsWith(".backblazeb2.com")) {
    const match2 = hostname.match(/^(?:[^.]+\.)?s3\.([^.]+)\.backblazeb2\.com$/);
    return match2 != null ? ["s3", match2[1]] : ["", ""];
  }

  // AWS S3
  const match = hostname.replace("dualstack.", "").match(/([^.]+)\.(?:([^.]*)\.)?amazonaws\.com(?:\.cn)?$/);
  let [service, region] = (match || ["", ""]).slice(1, 3);
  if (region === "us-gov") {
    region = "us-gov-west-1";
  } else if (region === "s3" || region === "s3-accelerate") {
    region = "us-east-1";
    service = "s3";
  } else if (service === "iot") {
    if (hostname.startsWith("iot.")) {
      service = "execute-api";
    } else if (hostname.startsWith("data.jobs.iot.")) {
      service = "iot-jobs-data";
    } else {
      service = pathname === "/mqtt" ? "iotdevicegateway" : "iotdata";
    }
  } else if (service === "autoscaling") {
    const targetPrefix = (headers.get("X-Amz-Target") || "").split(".")[0];
    if (targetPrefix === "AnyScaleFrontendService") {
      service = "application-autoscaling";
    } else if (targetPrefix === "AnyScaleScalingPlannerFrontendService") {
      service = "autoscaling-plans";
    }
  } else if (region == null && service.startsWith("s3-")) {
    region = service.slice(3).replace(/^fips-|^external-1/, "");
    service = "s3";
  } else if (service.endsWith("-fips")) {
    service = service.slice(0, -5);
  } else if (region && /-\d$/.test(service) && !/-\d$/.test(region)) {
    [service, region] = [region, service];
  }
  return [service, region];
}

/**
 * 获取缓存设置
 * @param {Object} env - 环境变量
 * @returns {Object} 缓存设置
 */
function getCacheSettings(env) {
  // 从环境变量获取缓存时间，如果没有设置则使用默认值
  const cacheTtl = parseInt(env.CACHE_TTL) || 86400; // 默认24小时
  const cdnCacheTtl = parseInt(env.CDN_CACHE_TTL) || 2592000; // 默认30天

  return {
    ttl: cacheTtl,
    cdnTtl: cdnCacheTtl,
  };
}

/**
 * 判断是否应该缓存请求
 * @param {string} method - HTTP方法
 * @param {URL} url - 请求URL
 * @param {Headers} headers - 请求头
 * @param {Object} env - 环境变量
 * @returns {boolean} 是否应该缓存
 */
function shouldCache(method, url, headers, env) {
  // 检查是否启用缓存
  if (env.CACHE_ENABLED === "false") {
    return false;
  }

  // 只缓存GET和HEAD请求
  if (!["GET", "HEAD"].includes(method)) {
    return false;
  }

  // Range请求缓存策略：
  if (headers.has("Range")) {
    console.log(`Range请求，允许缓存以优化视频播放体验: ${url.pathname}`);
    // 允许缓存Range请求
  }

  return true;
}

/**
 * 生成统一的缓存键（基于文件路径，忽略查询参数）
 * @param {URL} url - 请求URL
 * @param {string} method - HTTP方法
 * @returns {Request} 缓存键
 */
function generateCacheKey(url, method) {
  // 使用文件路径作为缓存键，忽略查询参数
  const cacheUrl = new URL(url);
  cacheUrl.search = ""; // 清除所有查询参数

  return new Request(cacheUrl.toString(), {
    method: method,
    headers: new Headers(), // 空头部，确保缓存键一致
  });
}

/**
 * 检查是否为下载请求
 * @param {URL} url - 请求URL
 * @returns {boolean} 是否为下载请求
 */
function isDownloadRequest(url) {
  return url.searchParams.has("response-content-disposition") || url.searchParams.get("response-content-disposition")?.includes("attachment");
}

/**
 * 检查是否包含阿里云OSS不支持的参数
 * @param {URL} url - 请求URL
 * @returns {boolean} 是否包含不支持的参数
 */
function hasUnsupportedOssParams(url) {
  // 阿里云OSS不支持response-content-type参数
  return url.searchParams.has("response-content-type");
}

/**
 * 处理下载响应头部（针对阿里云OSS优化）
 * @param {Response} response - 原始响应
 * @param {URL} originalUrl - 原始请求URL
 * @returns {Response} 处理后的响应
 */
function processDownloadResponse(response, originalUrl) {
  // 如果不是下载请求，直接返回
  if (!isDownloadRequest(originalUrl)) {
    return response;
  }

  // 检查是否已经有Content-Disposition头部
  if (response.headers.has("Content-Disposition")) {
    return response;
  }

  // 从URL参数中获取Content-Disposition
  const contentDisposition = originalUrl.searchParams.get("response-content-disposition");
  if (contentDisposition) {
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Content-Disposition", decodeURIComponent(contentDisposition));

    // 注意：阿里云OSS不支持response-content-type参数
    // 但我们可以在Worker层面处理Content-Type
    const responseContentType = originalUrl.searchParams.get("response-content-type");
    if (responseContentType && !response.headers.get("Content-Type")) {
      console.log(`Worker层面设置Content-Type: ${responseContentType}`);
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

/**
 * 验证请求来源（防盗链）
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {boolean} 验证是否通过
 */
function validateReferer(request, env) {
  // 如果没有配置允许的来源，直接允许
  if (!env.ALLOWED_REFERERS) {
    return true;
  }

  const referer = request.headers.get("Referer");
  if (!referer) {
    // 没有Referer头部，可能是直接访问，根据配置决定是否允许
    console.log("请求没有Referer头部");
    return true; // 默认允许，避免过于严格
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

/**
 * 添加CORS头部到响应
 * @param {Response} response - 原始响应
 * @param {string} cacheStatus - 缓存状态
 * @returns {Response} 添加了CORS头部的响应
 */
function addCorsHeaders(response, cacheStatus = "MISS") {
  const newResponse = new Response(response.body, response);

  // 添加CORS头部
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });

  // 添加缓存状态头部
  newResponse.headers.set("X-Cache-Status", cacheStatus);
  newResponse.headers.set("X-Served-By", "Cloudflare-Worker");

  return newResponse;
}

/**
 * 处理OPTIONS预检请求
 * @returns {Response} CORS预检响应
 */
function handleOptions() {
  return new Response(null, {
    status: 200,
    headers: CORS_HEADERS,
  });
}

/**
 * 构建阿里云OSS URL（用于内部签名）
 * @param {URL} originalUrl - 原始请求URL
 * @param {Object} env - 环境变量
 * @returns {string} OSS URL
 */
function buildOssUrl(originalUrl, env) {
  // 构建阿里云OSS的URL
  const ossUrl = new URL(originalUrl);

  // 使用阿里云OSS的标准域名格式
  ossUrl.hostname = `${env.OSS_BUCKET_NAME}.${env.OSS_REGION}.aliyuncs.com`;

  // 清除原始URL中的签名参数（如果有的话）
  ossUrl.searchParams.delete("X-Amz-Algorithm");
  ossUrl.searchParams.delete("X-Amz-Credential");
  ossUrl.searchParams.delete("X-Amz-Date");
  ossUrl.searchParams.delete("X-Amz-Expires");
  ossUrl.searchParams.delete("X-Amz-SignedHeaders");
  ossUrl.searchParams.delete("X-Amz-Signature");

  // 阿里云OSS特殊处理：移除不支持的response-content-type参数
  if (hasUnsupportedOssParams(ossUrl)) {
    console.log(`移除阿里云OSS不支持的response-content-type参数`);
    ossUrl.searchParams.delete("response-content-type");
  }

  return ossUrl.toString();
}

/**
 * 检查URL是否包含预签名参数
 * @param {URL} url - 要检查的URL
 * @returns {boolean} 是否包含预签名参数
 */
function hasPresignedParams(url) {
  return url.searchParams.has("X-Amz-Signature") || url.searchParams.has("X-Amz-Algorithm") || url.searchParams.has("X-Amz-Credential");
}

/**
 * 处理请求到OSS（智能选择签名方式）
 * @param {Request} request - 原始请求
 * @param {URL} originalUrl - 原始URL
 * @param {Object} env - 环境变量
 * @returns {Response} OSS响应
 */
async function handleOssRequest(request, originalUrl, env) {
  const hasSignature = hasPresignedParams(originalUrl);

  if (hasSignature) {
    // 有预签名参数：直接转发预签名URL（下载请求）
    console.log(`检测到预签名URL，直接转发: ${originalUrl.pathname}`);
    return await forwardPresignedUrl(request, originalUrl, env);
  } else {
    // 无预签名参数：Worker内部签名（预览请求）
    console.log(`无签名URL，Worker内部签名: ${originalUrl.pathname}`);
    return await signAndFetchFromOss(request, originalUrl, env);
  }
}

/**
 * 直接转发预签名URL到OSS
 * @param {Request} request - 原始请求
 * @param {URL} originalUrl - 原始URL
 * @param {Object} env - 环境变量
 * @returns {Response} OSS响应
 */
async function forwardPresignedUrl(request, originalUrl, env) {
  // 构建OSS URL，保留所有查询参数
  const ossUrl = buildOssUrl(originalUrl, env);

  // 过滤请求头部
  const filteredHeaders = filterHeaders(request.headers, env);

  // 直接转发请求
  const response = await fetch(ossUrl, {
    method: request.method,
    headers: filteredHeaders,
    body: request.body,
  });

  console.log(`📡 OSS响应状态: ${response.status} ${response.statusText}`);
  if (!response.ok) {
    // 克隆响应以避免ReadableStream错误
    const errorResponse = response.clone();
    const errorText = await errorResponse.text();
    console.log(`❌ OSS错误响应: ${errorText}`);
  }

  return response;
}

/**
 * 使用AWS4签名发送请求到OSS
 * @param {Request} request - 原始请求
 * @param {URL} originalUrl - 原始URL
 * @param {Object} env - 环境变量
 * @returns {Response} OSS响应
 */
async function signAndFetchFromOss(request, originalUrl, env) {
  // 构建OSS URL
  const ossUrl = buildOssUrl(originalUrl, env);

  // 创建AWS客户端 - 阿里云OSS兼容S3 API
  const awsClient = new AwsClient({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    secretAccessKey: env.OSS_SECRET_ACCESS_KEY,
    service: "s3",
    region: env.OSS_REGION,
  });

  // 过滤请求头部
  const filteredHeaders = filterHeaders(request.headers, env);

  // 使用AWS4签名
  const signedRequest = await awsClient.sign(ossUrl, {
    method: request.method,
    headers: filteredHeaders,
    body: request.body,
  });

  // 发送已签名的请求
  const response = await fetch(signedRequest);

  console.log(`📡 OSS响应状态: ${response.status} ${response.statusText}`);
  if (!response.ok) {
    // 克隆响应以避免ReadableStream错误
    const errorResponse = response.clone();
    const errorText = await errorResponse.text();
    console.log(`❌ OSS错误响应: ${errorText}`);
  }

  return response;
}

/**
 * 过滤请求头部
 * @param {Headers} headers - 原始请求头部
 * @param {Object} env - 环境变量
 * @returns {Headers} 过滤后的头部
 */
function filterHeaders(headers, env) {
  const filteredHeaders = new Headers();

  // 基本允许的头部
  const allowedHeaders = ["range", "if-modified-since", "if-none-match", "if-match", "content-type", "content-length", "cache-control", "authorization"];

  // 添加用户自定义的允许头部
  if (env.ALLOWED_HEADERS) {
    const customHeaders = env.ALLOWED_HEADERS.split(",").map((h) => h.trim().toLowerCase());
    allowedHeaders.push(...customHeaders);
  }

  // 只保留允许的头部
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (allowedHeaders.includes(lowerKey)) {
      filteredHeaders.set(key, value);
    }
  }

  return filteredHeaders;
}

/**
 * 处理缓存请求
 * @param {Request} request - 请求对象
 * @param {URL} originalUrl - 原始URL
 * @param {Object} env - 环境变量
 * @param {Object} ctx - 执行上下文
 * @returns {Response} 响应
 */
async function handleCachedRequest(request, originalUrl, env, ctx) {
  const cache = caches.default;

  // 生成统一的缓存键（基于文件路径，忽略查询参数）
  const cacheKey = generateCacheKey(originalUrl, request.method);

  // 尝试从缓存获取
  let cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    console.log(`缓存命中: ${originalUrl.pathname}`);

    // 处理下载响应头部（如果是下载请求）
    const processedResponse = processDownloadResponse(cachedResponse, originalUrl);

    return addCorsHeaders(processedResponse, "HIT");
  }

  // 缓存未命中，智能处理请求到OSS
  console.log(`缓存未命中，智能处理请求到OSS: ${originalUrl.pathname}`);

  let response = await handleOssRequest(request, originalUrl, env);

  // 检查是否应该缓存响应
  if (response.ok && shouldCache(request.method, originalUrl, request.headers, env)) {
    const cacheSettings = getCacheSettings(env);
    const cacheTtl = cacheSettings.ttl;
    const cdnCacheTtl = cacheSettings.cdnTtl;

    // 克隆响应用于缓存（移除下载相关头部，保存纯净内容）
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

    // 异步存储到缓存
    ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

    // 处理下载响应头部（如果是下载请求）
    const processedResponse = processDownloadResponse(responseToCache, originalUrl);

    return addCorsHeaders(processedResponse, "MISS");
  }

  // 处理下载响应头部（如果是下载请求）
  const processedResponse = processDownloadResponse(response, originalUrl);

  return addCorsHeaders(processedResponse, "BYPASS");
}

// 主要的Worker处理逻辑
export default {
  async fetch(request, env, ctx) {
    // 处理OPTIONS预检请求
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    // 只允许GET和HEAD请求
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

      // 验证来源（防盗链）
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

      // 检查是否应该使用缓存
      if (shouldCache(request.method, originalUrl, request.headers, env)) {
        return await handleCachedRequest(request, originalUrl, env, ctx);
      } else {
        // 不缓存，智能处理直接转发
        console.log(`直接转发（不缓存）: ${originalUrl.pathname}`);

        const response = await handleOssRequest(request, originalUrl, env);

        // 处理下载响应头部（如果是下载请求）
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
