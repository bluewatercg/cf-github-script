#!/bin/bash

# 配置参数
CF_API_TOKEN="your_api_token_here"
ACCOUNT_ID="your_account_id"
PROJECT_NAME="your_project_name"
KEEP=3 # 保留最新的3个版本
PAGE_SIZE=100  # 每页获取的数量（Cloudflare API允许的最大值）

# 获取所有部署（带分页支持）
ALL_DEPLOYMENTS="[]"
PAGE=1
while true; do
    echo "正在获取第 $PAGE 页部署..."
    DEPLOYMENTS=$(curl -s -X GET \
      "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}/deployments?page=${PAGE}&per_page=${PAGE_SIZE}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json")
    
    # 合并结果
    CURRENT_PAGE_DATA=$(echo "$DEPLOYMENTS" | jq '.result')
    ALL_DEPLOYMENTS=$(echo "$ALL_DEPLOYMENTS" | jq --argjson new "$CURRENT_PAGE_DATA" '. + $new')
    
    # 检查是否还有更多数据
    TOTAL_PAGES=$(echo "$DEPLOYMENTS" | jq '.result_info.total_pages')
    if [ "$PAGE" -ge "$TOTAL_PAGES" ]; then
        break
    fi
    ((PAGE++))
done

# 排序和筛选
SORTED_DEPLOYMENTS=$(echo "$ALL_DEPLOYMENTS" | jq -r 'map({id: .id, created_on: .created_on}) | sort_by(.created_on) | reverse')
ALL_DEPLOYMENT_IDS=$(echo "$SORTED_DEPLOYMENTS" | jq -r '.[].id')
TOTAL_DEPLOYMENTS=$(echo "$ALL_DEPLOYMENT_IDS" | wc -w)
COUNT_TO_DELETE=$((TOTAL_DEPLOYMENTS - KEEP))

if [ $COUNT_TO_DELETE -le 0 ]; then
    echo "无需删除旧部署，当前只有 $TOTAL_DEPLOYMENTS 个部署存在。"
    exit 0
fi
echo "共发现 $TOTAL_DEPLOYMENTS 个部署。将保留最新的 $KEEP 个，删除 $COUNT_TO_DELETE 个旧部署。"

# 获取需要删除的部署ID（跳过前$KEEP个最新的）
DEPLOYMENTS_TO_DELETE=$(echo "$SORTED_DEPLOYMENTS" | jq -r ".[$KEEP:][] | .id")

# 循环删除旧部署
for DEPLOYMENT_ID in $DEPLOYMENTS_TO_DELETE; do
    echo "正在删除部署 $DEPLOYMENT_ID..."
    RESPONSE=$(curl -s -X DELETE \
      "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}/deployments/${DEPLOYMENT_ID}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json")
    
    # 检查删除是否成功
    if echo "$RESPONSE" | jq -e '.success' > /dev/null; then
        echo "成功删除部署 $DEPLOYMENT_ID"
    else
        echo "删除部署 $DEPLOYMENT_ID 失败"
        echo "错误信息: $(echo "$RESPONSE" | jq -r '.errors[0].message')"
    fi
done
echo "清理完成。已保留最新的 $KEEP 个部署。"
