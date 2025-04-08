#!/bin/bash

# 配置信息
GIST_TOKEN="改为你的github token，需要有gist权限"
GIST_ID="改为你私有gist的id或留空"

# 颜色和符号定义
RED='\033[1;31m'    # 错误/警告
GREEN='\033[1;32m'  # 成功
YELLOW='\033[1;33m' # 提示
CYAN='\033[1;36m'   # 标题/链接
BLUE='\033[1;34m'   # 步骤
NC='\033[0m'        # 颜色重置

CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}➜${NC}"
DOT="${YELLOW}•${NC}"

show_help() {
    echo -e "${CYAN}用法:${NC} $0 [文件1] [文件2]..."
    echo -e "${YELLOW}示例:${NC}"
    echo -e "  $0 file.txt          ${CYAN}# 自动创建新Gist${NC}"
    echo -e "  GIST_ID=xxx $0 file  ${CYAN}# 更新现有Gist${NC}"
}

print_step() { echo -e "${DOT} ${BLUE}$1...${NC}"; }
print_success() { echo -e "${CHECK} ${GREEN}$1${NC}"; }
print_error() { echo -e "${CROSS} ${RED}错误: $1${NC}" >&2; }

convert_path() {
    local win_path="$1"
    win_path=$(echo "$win_path" | sed 's/ /_/g')  # 替换路径中的中文空格问题
    if command -v cygpath &> /dev/null; then
        cygpath -u "$win_path" 2>/dev/null || echo "$win_path"
    else
        echo "$win_path" | sed 's|\\|/|g; s|^$$[A-Za-z]$$:|/\1|'
    fi
}

# 检测文件编码
detect_encoding() {
    local encoding=$(file -b --mime-encoding "$1")
    echo -e "${YELLOW}检测 $1 文件编码 -> $encoding${NC}" >&2
    case $encoding in
        "utf-8")                  echo "UTF-8" ;;
        "iso-8859-1" | "cp936")    echo "GBK" ;;
        "utf-16le")                echo "UTF-16" ;;
        "unknown-8bit")            echo "GB18030" ;;
        "binary")                  echo "BASE64" ;;
        *)                         echo "$encoding" ;;
    esac | tr 'A-Z' 'a-z'
}

# 转换文件编码
process_content() {
    local detected_encoding=$(detect_encoding "$1")
    local content
    
    # 二进制文件特殊处理
    if [ "$detected_encoding" = "base64" ]; then
        print_error "不支持二进制文件: $1"
        exit 1
    fi

    # 智能编码转换（包含UTF-8验证）
    if [ "$detected_encoding" = "utf-8" ]; then
        content=$(sed '
            s/\r$//;
            1s/^\xEF\xBB\xBF//;
            s/[\x00-\x09\x0B-\x1F\x7F]//g;
        ' "$1")
    else
        content=$(iconv -f "$detected_encoding" -t UTF-8//TRANSLIT "$1" 2>/dev/null || 
                 iconv -f GBK -t UTF-8//TRANSLIT "$1" 2>/dev/null ||
                 iconv -f GB18030 -t UTF-8//TRANSLIT "$1")
    fi

    # 最终编码验证
    if ! echo "$content" | iconv -t UTF-8 -c &>/dev/null; then
        print_error "文件包含无效字符: $1"
        exit 1
    fi
    echo "$content"
}

# 主程序
[ $# -eq 0 ] && { show_help; exit 1; }

declare -A file_data
for file in "$@"; do
    print_step "处理文件 $file"
    resolved_file=$(convert_path "$file")
    
    # 文件验证
    if [ ! -f "$resolved_file" ]; then
        print_error "文件不存在: $resolved_file"
        exit 1
    fi
    
    filename=$(basename "$resolved_file")
    content=$(process_content "$resolved_file")
    
    # 内容验证
    if [ -z "$content" ]; then
        print_error "文件内容为空: $filename"
        exit 1
    fi
    
	file_data["$filename"]="$content"
    print_success "已加载 $filename (${#content} 字符)"
done

build_json() {
    jq -n --argjson files "$(
        jq -n --argjson data "$(
            for key in "${!file_data[@]}"; do
                jq -n --arg k "$key" --arg c "${file_data[$key]}" \
                    '{($k): {content: $c}}'
            done | jq -s 'add'
        )" '$data'
    )" '{public: false, files: $files}'
}

# API交互
print_step "准备API请求"
if [ -z "$GIST_ID" ]; then
    method="POST"
    endpoint="https://api.github.com/gists"
else
    method="PATCH"
    endpoint="https://api.github.com/gists/$GIST_ID"
fi

# 调试文件处理
DEBUG_JSON=".gist_debug.json"
build_json | jq . > "$DEBUG_JSON"

print_step "发送请求到GitHub"
response=$(curl -s -X "$method" \
  -H "Authorization: token $GIST_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d @"$DEBUG_JSON" \
  "$endpoint")

# 清理调试文件
rm -f "$DEBUG_JSON"

# 错误处理
if echo "$response" | grep -q '"message":'; then
    error_msg=$(echo "$response" | jq -r '.message')
    print_error "API请求失败: $error_msg"
    exit 1
fi

# 获取版本信息
GIST_ID=$(echo "$response" | jq -r '.id')
print_step "获取最新版本哈希"
COMMIT_HASH=$(curl -s -H "Authorization: token $GIST_TOKEN" \
    "https://api.github.com/gists/$GIST_ID" | jq -r '.history[0].version')

# 显示结果
echo -e "\n${CYAN}══════════════ Gist 信息 ══════════════${NC}"
echo -e "${YELLOW}Gist ID:${NC} $GIST_ID"
echo -e "${YELLOW}管理界面:${NC} https://gist.github.com/$GIST_ID"

for filename in "${!file_data[@]}"; do
    echo -e "\n${ARROW} ${YELLOW}文件:${NC} ${CYAN}$filename${NC}"
    echo -e "  ${GREEN}私有直链:${NC} https://gist.githubusercontent.com/raw/$GIST_ID/$COMMIT_HASH/$filename"
    echo -e "  ${BLUE}公开直链:${NC} https://gist.githubusercontent.com/raw/$GIST_ID/$filename"
done
echo -e "${CYAN}═══════════════════════════════════════${NC}"