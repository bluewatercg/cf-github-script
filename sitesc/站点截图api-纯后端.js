export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response('Server Error', { status: 500 });
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 验证必要环境变量
  const requiredEnvVars = [
    'APIFLASH_KEY', 
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_KEY',
    'S3_BUCKET',
    'CUSTOM_DOMAIN',
    'S3_ENDPOINT'
  ];
  
  const missingVars = requiredEnvVars.filter((key) => !env[key]);
  if (missingVars.length > 0) {
    return errorResponse(500, `缺少必要环境变量: ${missingVars.join(', ')}`);
  }

  // 限制路径前缀
  if (!path.startsWith('/sc/')) {
    return new Response(null, { status: 204 });
  }

  // 提取目标URL
  const targetUrl = decodeURIComponent(path.slice('/sc/'.length));
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return errorResponse(400, '需要有效的目标URL。示例: /sc/https://example.com');
  }

  // 提取并验证参数
  const fullPage = url.searchParams.get('fullPage') === 'true';
  const type = ['png', 'jpeg', 'webp'].includes(url.searchParams.get('type')) 
    ? url.searchParams.get('type') 
    : 'webp';
  const delay = Math.min(Math.max(parseInt(url.searchParams.get('delay')) || 2, 0), 10);
  const waitFor = url.searchParams.get('wait_for') || null;
  const width = parseInt(url.searchParams.get('width')) || 854;
  const height = parseInt(url.searchParams.get('height')) || 480;
  const quality = Math.min(Math.max(parseInt(url.searchParams.get('quality')) || 85, 0), 100);

  try {
    console.log(`开始截图: ${targetUrl}, 类型: ${type}, 分辨率: ${width}x${height}, 延迟: ${delay}s`);
    
    // 生成文件名与路径
    const filename = generateFilename(type);
    const s3Folder = (env.S3_KEY || 'apiflash').replace(/^\/+|\/+$/g, ''); // 清理路径
    const s3Path = `${s3Folder}/${filename}`; // 完整S3路径
    
    // 获取截图数据并直接上传到S3
    await takeAndUploadScreenshot({
      url: targetUrl,
      key: env.APIFLASH_KEY,
      fullPage,
      type,
      delay,
      waitFor,
      width,
      height,
      quality,
      s3AccessKeyId: env.S3_ACCESS_KEY_ID,
      s3SecretKey: env.S3_SECRET_KEY,
      s3Bucket: env.S3_BUCKET,
      s3Path,
      s3Endpoint: env.S3_ENDPOINT,
      s3Region: env.S3_REGION
    });
    
    // 根据S3端点确定存储类型
    let uploadType = "S3";
    if (env.S3_ENDPOINT.includes('backblazeb2.com')) {
      uploadType = "Backblaze B2";
    } else if (env.S3_ENDPOINT.includes('r2.cloudflarestorage.com')) {
      uploadType = "Cloudflare R2";
    }

    console.log(`截图成功并上传到${uploadType}`);
    
    // 构建响应JSON
    const responseData = {
      target_url: targetUrl,
      screenshot_time: getBeijingTime(),
      direct_url: `${env.CUSTOM_DOMAIN.replace(/\/+$/, '')}/${s3Path}`,
      upload_type: uploadType,
      bucket_name: env.S3_BUCKET,
      upload_path: s3Path
    };

    // 返回JSON响应
    return new Response(JSON.stringify(responseData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });

  } catch (error) {
    console.error('处理失败:', error);
    return errorResponse(500, `处理失败: ${error.message}`);
  }
}

// 获取北京时间函数
function getBeijingTime() {
  const now = new Date();
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(now.getTime() + beijingOffset);
  return formatDate(beijingTime);
}

// 格式化日期为 YYYY-MM-DD HH:mm:ss
function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = padZero(date.getUTCMonth() + 1);
  const day = padZero(date.getUTCDate());
  const hours = padZero(date.getUTCHours());
  const minutes = padZero(date.getUTCMinutes());
  const seconds = padZero(date.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function takeAndUploadScreenshot({ 
  url, 
  key, 
  fullPage = false, 
  type = 'webp', 
  delay = 2, 
  waitFor = null,
  width = 854,
  height = 480,
  quality = 85,
  s3AccessKeyId,
  s3SecretKey,
  s3Bucket,
  s3Path,
  s3Endpoint,
  s3Region
}) {
  // 构建API参数
  const params = new URLSearchParams({
    access_key: key,
    url: url,
    format: type === 'jpeg' ? 'jpg' : type === 'png' ? 'png' : 'webp',
    width: width.toString(),
    height: height.toString(),
    fresh: 'true',
    full_page: fullPage ? 'true' : 'false',
    quality: quality.toString(),
    delay: Math.max(delay, 1).toString(),
    no_cookie_banners: 'true',
    no_ads: 'true',
    no_tracking: 'true',
    
    // S3上传参数
    s3_access_key_id: s3AccessKeyId,
    s3_secret_key: s3SecretKey,
    s3_bucket: s3Bucket,
    s3_key: s3Path,
    response_type: 'json'
  });

  // 添加S3参数
  params.append('s3_endpoint', s3Endpoint);
  if (s3Region) params.append('s3_region', s3Region);
  
  // 添加等待参数
  if (waitFor) {
    params.append('wait_for', waitFor);
  } else {
    params.append('wait_until', 'network_idle');
  }

  const controller = new AbortController();
  const timeoutMs = (delay + 30) * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const apiUrl = `https://api.apiflash.com/v1/urltoimage?${params}`;
    console.log(`调用截图API: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { 
        'User-Agent': 'Cloudflare-Screenshot-Worker'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = '无响应体';
      try {
        errorBody = await response.text();
      } catch {}
      throw new Error(`截图API错误: ${response.status} - ${errorBody}`);
    }
    
    // 解析API响应
    const result = await response.json();
    if (!result || !result.url) {
      throw new Error('截图API返回无效的S3响应');
    }
  } catch (error) {
    clearTimeout(timeoutId);
    throw new Error(`截图请求失败: ${error.message}`);
  }
}

// 辅助函数
function generateFilename(ext) {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    padZero(now.getUTCMonth() + 1),
    padZero(now.getUTCDate()),
    '-',
    padZero(now.getUTCHours()),
    padZero(now.getUTCMinutes()),
    padZero(now.getUTCSeconds())
  ].join('');
  return `screenshot-${timestamp}.${ext}`;
}

function padZero(n) {
  return n < 10 ? '0' + n : n;
}

function errorResponse(status, msg) {
  return new Response(msg, {
    status,
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
