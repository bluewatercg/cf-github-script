## gitfiles-plus.js 部署教程
<https://blog.811520.xyz/post/2025/04/github-gist-files/>

## 功能概述
- 通过 GitHub API 上传文件到 GitHub 仓库或 Gist
- 提供文件直链生成功能
- 支持文件管理界面查看上传记录
- 支持删除数据库记录
- 支持删除真实文件
- 支持 API 接口调用，详见 [API 文档](#API文档)

## worker环境变量

- COOKIE_DAYS：cookie有效期，默认7天
- GH_TOKEN：API功能必须
- PASSWORD：登录密码，默认123123
- RAW_DOMAIN：私库域名

## API文档

### 上传文件

**端点**: POST /api/upload

**参数**:
- **upload-type**: 必填，值为 gist 或 github
- **files**: 必填，上传的文件（可多个）
- **gist-public**: 可选，值为 on 或 off，仅当 upload-type 为 gist 时有效
- **existing-gist**: 可选，值为已存在的 Gist ID，仅当 upload-type 为 gist 时有效
- **gh-user**: 可选，值为 GitHub 用户名，仅当 upload-type 为 github 时有效
- **gh-repo**: 可选，值为 GitHub 仓库名，仅当 upload-type 为 github 时有效
- **gh-branch**: 可选，值为 GitHub 分支名，仅当 upload-type 为 github 时有效
- **gh-path**: 可选，值为 GitHub 仓库路径，仅当 upload-type 为 github 时有效

**命令示例**

- Gist 上传
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_GH_TOKEN" \
  -F "upload-type=gist" \
  -F "gist-public=on" \
  -F "files=@file1.txt" \
  -F "files=@file2.png" \
  http://your-domain.com/api/upload
```

- GitHub 上传
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_GH_TOKEN" \
  -F "upload-type=github" \
  -F "gh-user=your_username" \
  -F "gh-repo=your_repo" \
  -F "gh-branch=main" \
  -F "gh-path=/subdir" \
  -F "files=@file1.txt" \
  -F "files=@file2.txt" \
  http://your-domain.com/api/upload
```

**响应示例（200 OK）**:

```json
[
  {
    "filename": "文件名",
    "filesize": "文件大小",
    "upload_type": "github/gist",
    "upload_time": "ISO时间戳",
    "page_url": "页面地址",
    "direct_url": "直链地址",
    "gist_id": "Gist ID (仅gist)",
    "gh_user": "GitHub用户 (仅github)",
    "gh_repo": "仓库名 (仅github)"
  },
  //...其他文件结果
]
```

### 查询文件

**端点**: GET /api/qry

**参数**: 
- **page=1**: 分页参数（默认第 1 页）
- **all_pages=true**: 查询所有页

**命令示例**

```bash
# 查询第一页
curl "http://your-domain.com/api/qry?page=1"
# 查询第二页
curl "http://your-domain.com/api/qry?page=2"
# 查询所有页
curl "https://your-domain.com/api/qry?all_pages=true"
```

**响应示例（200 OK）**:

```json
[
  {
    "id": "文件记录ID",
    "filename": "文件名",
    "filesize": "文件大小",
    "upload_type": "github/gist",
    "upload_time": "上传时间",
    "page_url": "页面地址",
    "direct_url": "直链地址"
  },
  //...其他记录
]
```

### 删除记录

**端点**: DELETE /api/rec/{ids}

**参数**: ids: 逗号分隔的记录 ID，如：1,2,3

**命令示例**:

```bash
curl -X DELETE "https://your-domain.com/api/rec/1,2,3"
```

**响应示例（200 OK）**:

```json
{
  "operation": "删除记录",
  "total": "总操作数",
  "success_count": "成功数",
  "failed_count": "失败数",
  "results": [
    {
      "id": "记录ID",
      "success": "true/false",
      "filename": "文件名",
      "upload_type": "类型",
      "error": "错误信息 (失败时)"
    }
    //...其他结果
  ]
}
```

### 删除文件及记录

**端点**: DELETE /api/del/{ids}

**参数**: ids: 逗号分隔的记录 ID，如：1,2,3

**命令示例**:

```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_GH_TOKEN" \
  "https://your-domain.com/api/del/1,2,3"
```

**响应示例（200 OK）**:

```Json
{
  "operation": "删除文件",
  "total": "总操作数",
  "success_count": "成功数",
  "failed_count": "失败数",
  "results": [
    {
      "id": "记录ID",
      "success": "true/false",
      "filename": "文件名",
      "upload_type": "类型",
      "error": "错误信息 (失败时)"
    }
    //...其他结果
  ]
}
```
