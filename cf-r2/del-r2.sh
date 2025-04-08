#!/bin/bash
# 配置参数
BUCKET_NAME="your-bucket" # 存储桶名称
ACCOUNT_ID= ""  # Cloudflare 账户ID
R2_ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
ACCESS_KEY="your_access_key" # R2 Access Key ID
SECRET_KEY="your_secret_key" # R2 Access Secret Key
KEEP=3
MAX_ITEMS=1000  # 单次请求最大文件数（Cloudflare R2限制）

# 依赖检查
if ! command -v aws &> /dev/null || ! command -v jq &> /dev/null; then
  echo "错误：请先安装AWS CLI和jq工具" >&2
  exit 1
fi

# 初始化变量
ALL_FILES="[]"
NEXT_TOKEN=""  # 分页标记

# 分页获取所有文件（处理文件数量限制）
echo "正在分页获取文件列表..."
while :; do
  # 带分页参数的请求
  RESPONSE=$(aws s3api list-objects-v2 \
    --bucket "$BUCKET_NAME" \
    --endpoint-url "$R2_ENDPOINT" \
    --aws-access-key-id "$ACCESS_KEY" \
    --aws-secret-access-key "$SECRET_KEY" \
    --max-items "$MAX_ITEMS" \
    ${NEXT_TOKEN:+--starting-token "$NEXT_TOKEN"} \
    --output json 2>&1)  # 捕获错误输出

  # 错误处理
  if ! echo "$RESPONSE" | jq -e '.Contents' >/dev/null 2>&1; then
    echo "获取文件列表失败！错误信息：" >&2
    echo "$RESPONSE" >&2
    exit 1
  fi

  # 合并结果
  CURRENT_PAGE=$(echo "$RESPONSE" | jq -c '[.Contents[]]')
  ALL_FILES=$(echo "$ALL_FILES" | jq --argjson new "$CURRENT_PAGE" '. + $new')

  # 检查是否还有更多数据
  NEXT_TOKEN=$(echo "$RESPONSE" | jq -r '.NextToken')
  [ -z "$NEXT_TOKEN" ] || [ "$NEXT_TOKEN" = "null" ] && break
done

# 按修改时间排序并提取待删除文件（安全处理特殊字符）
FILES_TO_DELETE=$(echo "$ALL_FILES" | \
  jq -r 'sort_by(.LastModified) | reverse['$KEEP':][] | .Key | @sh')

# 统计文件数
TOTAL_FILES=$(echo "$ALL_FILES" | jq 'length')
TO_DELETE=$(echo "$FILES_TO_DELETE" | wc -w)

if [ "$TO_DELETE" -le 0 ]; then
  echo "无需删除，当前文件数：$TOTAL_FILES"
  exit 0
fi

# 删除旧文件（带错误处理和进度反馈）
echo "开始删除 $TO_DELETE 个旧文件（共 $TOTAL_FILES 个文件）..."
COUNTER=0
for file in $FILES_TO_DELETE; do
  # 去除单引号（jq @sh生成的引号）
  CLEAN_KEY=$(eval echo "$file")
  
  # 删除操作（带重试逻辑）
  RETRY=0
  while [ "$RETRY" -lt 3 ]; do
    if aws s3api delete-object \
      --bucket "$BUCKET_NAME" \
      --key "$CLEAN_KEY" \
      --endpoint-url "$R2_ENDPOINT" \
      --aws-access-key-id "$ACCESS_KEY" \
      --aws-secret-access-key "$SECRET_KEY"; then
      echo "[成功] 删除: $CLEAN_KEY"
      ((COUNTER++))
      break
    else
      ((RETRY++))
      echo "[重试 $RETRY/3] 删除失败: $CLEAN_KEY" >&2
      sleep 1
    fi
  done

  # 最终失败处理
  if [ "$RETRY" -eq 3 ]; then
    echo "[错误] 无法删除: $CLEAN_KEY" >&2
  fi
done

echo "操作完成。成功删除 $COUNTER/$TO_DELETE 个文件，保留最新 $KEEP 个文件。"
