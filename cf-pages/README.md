## del-pages.sh 使用说明

### 修改脚本开头的配置参数：

- API_TOKEN: Cloudflare API 令牌，需要编辑pages的权限
- ACCOUNT_ID: Cloudflare 账户 ID
- PROJECT_NAME: Pages 项目名称
- KEEP: 保留的部署数量，默认保留最新的3个

### 使用方式

- 默认保留最新3个部署：`bash del-pages.sh`
- 保留最新5个部署：`bash del-pages.sh 5`

## 注意事项

- 删除操作不可逆，请确保已备份重要数据
- 生产环境使用前建议先在测试项目上验证
