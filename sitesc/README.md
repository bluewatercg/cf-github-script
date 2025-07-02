## 环境变量配置说明：

| 环境变量           | 必填 | 默认值     | 说明                                       |
| ------------------ | ---- | ---------- | ------------------------------------------ |
| `APIFLASH_KEY`     | 是   | -          | APIFlash API 密钥                          |
| `S3_ACCESS_KEY_ID` | 是   | -          | S3 访问密钥 ID                             |
| `S3_SECRET_KEY`    | 是   | -          | S3 密钥访问密钥                            |
| `S3_BUCKET`        | 是   | -          | S3 存储桶名称                              |
| `CUSTOM_DOMAIN`    | 是   | -          | 自定义域名 (如`https://b2qq.xxxxxx.com`) |
| `S3_ENDPOINT`      | 是   | -          | S3 端点 URL                                |
| `S3_KEY`           | 否   | `apiflash` | S3 存储路径前缀                            |
| `S3_REGION`        | 否   | -          | S3 区域                                    |

## 兼容性说明：

此代码兼容以下 S3 兼容存储服务：

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
