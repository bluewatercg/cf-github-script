export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.slice(1).split('/');
    const defaultBucket = env.BUCKET_NAME || "netjett";

    // 1. 智能解析存储桶和对象键
    let bucket, objectKey;

    if (pathSegments.length === 0) {
      return new Response('Missing object path', { status: 400 });
    } else if (pathSegments.length === 1) {
      bucket = defaultBucket;
      objectKey = pathSegments[0];
    } else {
      if (pathSegments[0] === defaultBucket) {
        bucket = defaultBucket;
        objectKey = pathSegments.slice(1).join('/');
      } else {
        bucket = defaultBucket;
        objectKey = pathSegments.join('/');
      }
    }

    // 2. 环境变量配置
    const MINIO_ENDPOINT = env.MINIO_ENDPOINT || "https://ossapi.yyy.us.kg";
    const ACCESS_KEY = env.ACCESS_KEY;
    const SECRET_KEY = env.SECRET_KEY;

    if (!objectKey) {
      return new Response('Missing object key', { status: 400 });
    }

    if (!ACCESS_KEY || !SECRET_KEY) {
      return new Response('Missing credentials', { status: 500 });
    }

    // 3. 生成预签名URL
    const now = new Date();
    const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = datetime.slice(0, 8);
    const expires = 86400; // 24小时有效期

    const queryParams = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${ACCESS_KEY}/${date}/auto/s3/aws4_request`,
      'X-Amz-Date': datetime,
      'X-Amz-Expires': expires,
      'X-Amz-SignedHeaders': 'host'
    };

    const canonicalUri = `/${bucket}/${objectKey}`;
    const canonicalQueryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalHeaders = `host:${new URL(MINIO_ENDPOINT).hostname}\n`;
    const signedHeaders = 'host';

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD'
    ].join('\n');

    // 签名计算
    const credentialScope = `${date}/auto/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      datetime,
      credentialScope,
      await sha256(canonicalRequest)
    ].join('\n');

    const dateKey = await hmacSha256('AWS4' + SECRET_KEY, date);
    const dateRegionKey = await hmacSha256(dateKey, 'auto');
    const dateRegionServiceKey = await hmacSha256(dateRegionKey, 's3');
    const signingKey = await hmacSha256(dateRegionServiceKey, 'aws4_request');
    const signature = await hmacSha256(signingKey, stringToSign, 'hex');

    queryParams['X-Amz-Signature'] = signature;

    // 4. 构建目标URL
    const minioUrl = `${MINIO_ENDPOINT}/${bucket}/${objectKey}?${new URLSearchParams(queryParams)}`;

    // 5. 转发请求到MinIO
    return fetch(minioUrl, {
      headers: {
        'Host': new URL(MINIO_ENDPOINT).hostname,
        'Accept': request.headers.get('Accept') || '*/*'
      }
    });
  }
};

// ----------------------------
// 辅助函数 (保持不变)
// ----------------------------
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key, message, outputEncoding = null) {
  const keyBuffer = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const msgBuffer = new TextEncoder().encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgBuffer);

  if (outputEncoding === 'hex') {
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return new Uint8Array(signature);
}
