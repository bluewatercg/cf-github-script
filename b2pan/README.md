## worker-public.js

针对公开的B2桶，需要绑定信用卡，扣费1刀  

修改此处

```js
const newPath = `/file/此处改为你的存储桶名称${url.pathname}`;
```

## worker-private.js

针对私有的B2桶，无需绑卡

环境变量: 

- **ALLOW_LIST_BUCKET** = false
- **B2_APPLICATION_KEY** = 应用秘钥 applicationKey
- **B2_APPLICATION_KEY_ID** = 应用 keyID
- **B2_ENDPOINT** = 端点地址（如 s3.us-west-004.backblazeb2.com）
- **BUCKET_NAME** = 桶名（如 123abc）
