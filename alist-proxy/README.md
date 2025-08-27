## worker 反代 Alist 下载，生成直链地址

## 四个环境变量

- ADDRESS：alist服务端地址，示例：`https://alist.domain.com`
- WORKER_ADDRESS：部署本worker后得到的地址，可以绑定域名，示例：`https://alist.worker.com`
- DISABLE_SIGN：是否关闭签名验证，默认 false，这里需要设置为 `true`
- TOKEN：alist的api token，示例：`alist-xxxxxxxxxxxxxxxxxx`

> **📌 提示**
> 
> AList API Token 获取方法：`AList 管理 → 设置 → 其他 → 令牌`，生成后务必保存！

## 完整教程

https://blog.811520.xyz/post/2025/08/250827-alist-proxy/
