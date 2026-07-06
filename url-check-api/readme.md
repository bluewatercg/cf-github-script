## URL CHECK API

> [!TIP]
> 检测 URL 可达性，支持重定向站点

## 使用

- get 请求
```
https://your-worker.xx.workers.dev/api/status?url=https://example.com
```

## 返回 json
```json
{
  "url": "https://baidu.com",
  "status": "reachable",
  "http_code": 200,
  "latency_ms": 562,
  "content_type": "text/html",
  "server": "cloudflare",
  "redirect_chain": [
    {
      "from": "https://www.baidu.com/",
      "status": 301
    }
  ],
  "error": null,
  "final_url": "https://www.baidu.com/"
}
```
