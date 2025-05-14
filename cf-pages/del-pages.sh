#!/bin/bash

# 配置变量（请根据需要修改）
API_TOKEN=""       # 需要 Pages 和 Workers 的编辑权限
ACCOUNT_ID=""      # 你的 Cloudflare 账户 ID
PROJECT_NAME=""    # 项目名

# 默认保留最新部署数量（可通过脚本参数覆盖）
KEEP=3

# 如果传入了参数则覆盖默认保留数量
if [[ -n "$1" ]]; then
  KEEP=$1
fi

# 检查必要变量是否已设置
if [[ -z "$API_TOKEN" || -z "$ACCOUNT_ID" || -z "$PROJECT_NAME" ]]; then
  echo "❌ 错误：请先设置 API_TOKEN, ACCOUNT_ID 和 PROJECT_NAME"
  exit 1
fi

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
echo "📦 共获取到 $total 个部署。"

# 排序并获取要保留的最新 N 个
keep_ids=$(printf "%s\n" "${all_deployments[@]}" | tac | head -n "$KEEP")
delete_ids=$(printf "%s\n" "${all_deployments[@]}" | grep -vxFf <(echo "$keep_ids"))

if [[ -z "$delete_ids" ]]; then
  echo "✅ 无需删除部署，已满足保留数量 $KEEP。"
  exit 0
fi

echo "🚮 将删除以下部署（保留最近 $KEEP 个）:"
echo "$delete_ids"

# 删除旧部署
for id in $delete_ids; do
  echo "🗑️ 正在删除部署 ID: $id"
  curl -s -X DELETE -H "Authorization: Bearer $API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments/$id" | jq
done

echo "✅ 所有旧部署已删除完成。"
