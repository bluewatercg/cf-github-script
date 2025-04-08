## del-pages.sh 使用说明

修改脚本开头的配置参数：

- CF_API_TOKEN: 您的 Cloudflare API 令牌，需要编辑pages的权限
- ACCOUNT_ID: 您的 Cloudflare 账户 ID
- PROJECT_NAME: 您的 Pages 项目名称
- 给脚本执行权限：chmod +x del-pages.sh
- 运行脚本：bash ./del-pages.sh

## 注意事项

- 此脚本需要安装 jq 工具来处理 JSON 数据（可通过 brew install jq 或 apt-get install jq 安装）
- 脚本默认会保留最新的 3 个部署版本，删除更早的版本
- 删除操作不可逆，请确保已备份重要数据
- 生产环境使用前建议先在测试项目上验证
- 如果部署数量很多，可能需要调整 API 的分页参数
