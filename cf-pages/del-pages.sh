#!/bin/bash

# 配置变量
API_TOKEN="" # 需要pages和woker的编辑权限
ACCOUNT_ID="" # 账户ID
PROJECT_NAME="" # 项目名
KEEP=3 # 默认保留最新的3个

# 存储所有部署 ID 的数组
all_deployments=()

# 页码初始值
page=1
per_page=20

echo "⏳ 正在获取所有部署记录..."

# 遍历所有页面
while true; do
  response=$(curl -s -H "Authorization: Bearer $API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments?page=$page&per_page=$per_page")

  deployments=$(echo "$response" | jq '.result')
  count=$(echo "$deployments" | jq 'length')

  if [ "$count" -eq 0 ]; then
    break
  fi

  ids=$(echo "$deployments" | jq -r '.[].id')
  all_deployments+=($ids)

  ((page++))
done

total=${#all_deployments[@]}

echo "共获取到 $total 个部署。"

# 排序并获取要保留的最新3个
keep_ids=$(printf "%s\n" "${all_deployments[@]}" | tac | head -n $KEEP)
delete_ids=$(printf "%s\n" "${all_deployments[@]}" | grep -vxFf <(echo "$keep_ids"))

echo "将删除以下部署（保留最近3个）:"
echo "$delete_ids"

# 删除旧部署
for id in $delete_ids; do
  echo "🗑️ 正在删除部署 ID: $id"
  curl -s -X DELETE -H "Authorization: Bearer $API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments/$id" | jq
done

echo "✅ 所有旧部署已删除完成。"
