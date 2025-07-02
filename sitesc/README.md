## 简介
此脚本是一个 Cloudflare Worker，用于截取网页并将截图自动上传到指定的 S3 兼容存储（如 AWS S3、Backblaze B2 或 Cloudflare R2）。它支持各种参数配置，例如截图格式、延迟、图像质量和截图区域等，能够根据请求自动生成截图并返回 S3 存储的 URL。

## 部署
直接部署到 CF worker

## 环境变量配置说明：

| 环境变量           | 必填 | 默认值     | 说明                                       |
| ------------------ | ---- | ---------- | ------------------------------------------ |
| `APIFLASH_KEY`     | 是   | -          | APIFlash API 密钥                          |
| `S3_ACCESS_KEY_ID` | 是   | -          | S3 访问密钥 ID                             |
| `S3_SECRET_KEY`    | 是   | -          | S3 密钥访问密钥                            |
| `S3_BUCKET`        | 是   | -          | S3 存储桶名称                              |
| `CUSTOM_DOMAIN`    | 是   | -          | 自定义域名 (如`https://b2qq.xxxxxx.com`) |
| `S3_ENDPOINT`      | 是   | -          | S3 端点 URL                                |
| `S3_KEY`           | 否   | `apiflash` | S3 存储路径前缀（即文件夹名）               |
| `S3_REGION`        | 否   | -          | S3 区域                                    |

## 兼容性说明：

1. **Cloudflare R2**：
	 - `S3_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com`
	 - `upload_type`: "Cloudflare R2"
	 
2. **Backblaze B2**：
	 - `S3_ENDPOINT`: `https://s3.<region>.backblazeb2.com`
	 - `upload_type`: "Backblaze B2"
	
3. **其他 S3 兼容服务**：
	 - 将使用默认的 "S3" 作为 `upload_type`

## 使用说明：

**请求方式**：`get`

**接口路径**：`/sc`

**接口示例**: 被截图的网站必须带 `http://` 或 `https://` 前缀

```html
https://your-worker-url/sc/https://github.com
```

## 进阶用法

- 指定截图类型 `type`，默认`webp`，支持 `jpg、png、webp`

```html
https://your-worker-url/sc/https://github.com?type=png
```

- 其他主要参数

| 参数名           | 默认值 | 释义     |
| ------------------ | ---- | ---------- |
| `wait_until`     | network_idle   | dom_loaded：html加载即截图；page_loaded：网页完整加载；network_idle：页面完整加载且网络空闲  |
| `width`          | 854 | 截图宽度，单位：像素 |
| `height`         | 480 | 截图高度，单位：像素 |
| `quality`        | 85  | 图片质量，仅当 type 为 jpg 时生效 |
| `delay`          | 2   | 延迟，单位：秒，延迟X秒截图；当设置了 wait_until 后可忽略此参数 |

示例：

```html
https://your-worker-url/sc/https://github.com?type=png?width=1920?height=1080?wait_until=page_loaded
```

## 支持的上传平台

1. **Cloudflare R2**：
   * `S3_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com`
   * `upload_type`: "Cloudflare R2"
     
2. **Backblaze B2**：
   * `S3_ENDPOINT`: `https://s3.<region>.backblazeb2.com`
   * `upload_type`: "Backblaze B2"
     
3. **其他 S3 兼容服务**：
   * 将使用默认的 "S3" 作为 `upload_type`

## 返回数据示例

```json
{
  "target_url": "https://example.com",
  "screenshot_time": "2025-07-02 10:30:45",
  "direct_url": "https://b2qq.xxxxxx.com/apiflash/screenshot-20250702103045.png",
  "upload_type": "Cloudflare R2", // 或 "Backblaze B2"
  "bucket_name": "your-bucket-name",
  "upload_path": "apiflash/screenshot-20250702103045.png"
}
```

**其中 `direct_url` 即为截图上传后的直链地址**
