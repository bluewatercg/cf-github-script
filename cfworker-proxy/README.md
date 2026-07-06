# proxy-url.js

## 反向代理 Worker — 配置说明

```
https://worker域名/https://google.com
https://worker域名/https://google.com/search?q=test

https://worker域名/google.com
https://worker域名/google.com/search?q=test

# http 不可省略协议头
https://worker域名/http://example.com
https://worker域名/http://127.0.0.1:8080
```

## 目录

1. [配置方式概述](#1-配置方式概述)
2. [环境变量一览](#2-环境变量一览)
3. [代码内硬编码配置](#3-代码内硬编码配置)
4. [各配置项详解](#4-各配置项详解)
5. [在 Cloudflare Dashboard 设置环境变量](#5-在-cloudflare-dashboard-设置环境变量)
6. [通过 wrangler.toml 设置环境变量](#6-通过-wranglertoml-设置环境变量)
7. [优先级规则](#7-优先级规则)
8. [配置示例汇总](#8-配置示例汇总)

---

## 1. 配置方式概述

本 Worker 支持**两种配置方式**，可同时使用：

| 方式 | 位置 | 适用场景 |
|------|------|----------|
| **环境变量** | Cloudflare Dashboard → Workers → 你的 Worker → **变量** 页面 | ✅ 生产环境推荐，不改代码即可调整 |
| **硬编码默认值** | `proxy-worker.js` 顶部 `DEFAULT_*` 常量 | ✅ 开发/测试方便，也用作环境变量未设置时的后备 |

> **优先级：** 环境变量 > 硬编码默认值（详见第 7 节）

---

## 2. 环境变量一览

在 Cloudflare Dashboard 中设置以下变量名即可覆盖对应的代码默认值：

| 变量名 | 类型 | 对应代码常量 | 说明 |
|--------|------|-------------|------|
| `BLOCKED_REGION` | JSON 数组 **或** 逗号分隔字符串 | `DEFAULT_BLOCKED_REGION` | 屏蔽的国家/地区代码 |
| `BLOCKED_IP_ADDRESS` | JSON 数组 **或** 逗号分隔字符串 | `DEFAULT_BLOCKED_IP_ADDRESS` | 屏蔽的 IP 地址 |
| `REPLACE_DICT` | JSON 对象 **（必须用 JSON）** | `DEFAULT_REPLACE_DICT` | HTML 文本替换规则 |
| `SPECIAL_CASES` | JSON 对象 **（必须用 JSON）** | `DEFAULT_SPECIAL_CASES` | 动态请求头规则 |

---

## 3. 代码内硬编码配置

在 `proxy-worker.js` 顶部找到以下常量，直接修改代码中的默认值：

```javascript
// ================= 配置区域（硬编码默认值） =================
const DEFAULT_BLOCKED_REGION = [];       // 国家屏蔽
const DEFAULT_BLOCKED_IP_ADDRESS = [];   // IP 屏蔽
const DEFAULT_REPLACE_DICT = {};         // 文本替换
const DEFAULT_SPECIAL_CASES = {};        // 请求头规则
```

---

## 4. 各配置项详解

### 4.1 BLOCKED_REGION — 国家/地区屏蔽

**作用：** 限制来自某些国家/地区的访问，匹配时返回 403。

**格式：** ISO 3166-1 alpha-2 国家代码（大写）。

硬编码示例：

```javascript
const DEFAULT_BLOCKED_REGION = ["KP", "SY", "PK", "CU"];
```

环境变量示例（JSON 数组）：

```json
["KP", "SY", "PK", "CU"]
```

环境变量示例（逗号分隔，= 自动解析为数组）：

```
KP,SY,PK,CU
```

> **Tip：** 国家代码由 Cloudflare 的 `cf-ipcountry` 请求头提供，仅当流量经过 Cloudflare 网络时有效。

---

### 4.2 BLOCKED_IP_ADDRESS — IP 地址屏蔽

**作用：** 屏蔽特定 IP 地址的访问，匹配时返回 403。

硬编码示例：

```javascript
const DEFAULT_BLOCKED_IP_ADDRESS = ["0.0.0.0", "127.0.0.1"];
```

环境变量示例（JSON 数组）：

```json
["192.168.1.1", "10.0.0.1"]
```

环境变量示例（逗号分隔）：

```
192.168.1.1,10.0.0.1
```

---

### 4.3 REPLACE_DICT — HTML 文本替换

**作用：** 在 HTML 响应中额外执行自定义文本替换。**支持占位符：**

| 占位符 | 运行时替换为 |
|--------|-------------|
| `$upstream` | 目标域名（如 `example.com`） |
| `$custom_domain` | 当前 Worker 域名（如 `my-worker.xxx.workers.dev`） |

硬编码示例：

```javascript
const DEFAULT_REPLACE_DICT = {
  "$upstream": "$custom_domain",
  "//github.com": "",
};
```

环境变量示例（⚠️ **必须使用 JSON 格式**）：

```json
{"$upstream": "$custom_domain", "//github.com": ""}
```

> **注意：** 这是纯文本字符串替换（非正则），在 HTML 自动 URL 重写**之后**执行。主要用于处理自动重写无法覆盖的边界情况。
>
> ⚠️ 误报风险：全局替换可能误伤页面正文中的文本，请谨慎配置。

---

### 4.4 SPECIAL_CASES — 动态请求头规则

**作用：** 按目标域名配置对**出站请求头**的处理方式，支持通配符域名 `*`。

每个规则的值可以是：

| 值 | 含义 |
|----|------|
| `"KEEP"` | 保留原始值，不覆盖 Worker 自动设置的该头 |
| `"DELETE"` | 删除该请求头 |
| 其他字符串 | 将该请求头设置为指定的值 |

硬编码示例：

```javascript
const DEFAULT_SPECIAL_CASES = {
  "*": {
    "Origin": "DELETE",
    "Referer": "DELETE",
  },
  "api.example.com": {
    "X-API-Key": "my-secret-key",
  },
};
```

环境变量示例（⚠️ **必须使用 JSON 格式**）：

```json
{"*":{"Origin":"DELETE","Referer":"DELETE"},"api.example.com":{"X-API-Key":"my-secret-key"}}
```

**处理顺序：**

1. 先应用 `*` 通配规则
2. 再应用具体域名规则（如有，会覆盖通配规则中的同名键）

---

## 5. 在 Cloudflare Dashboard 设置环境变量

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击你的 Worker 名称
4. 进入 **设置** → **变量**
5. 在 **环境变量** 区域点击 **添加变量**
6. 填入变量名和值（参考上文的格式要求）
7. 点击 **保存并部署**

> **加密变量：** 敏感值（如 API Key）可勾选 **加密**，该变量在 Dashboard 中会以密文显示，不影响 Worker 读取。

---

## 6. 通过 wrangler.toml 设置环境变量

如果使用 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) 部署，可以在 `wrangler.toml` 中设置：

```toml
name = "my-proxy-worker"
main = "proxy-worker.js"

# 普通环境变量
[vars]
BLOCKED_REGION = '["KP","SY","PK","CU"]'
BLOCKED_IP_ADDRESS = "192.168.1.1,10.0.0.1"
REPLACE_DICT = '{"$upstream":"$custom_domain"}'
SPECIAL_CASES = '{"*":{"Origin":"DELETE","Referer":"DELETE"}}'
```

然后运行：

```bash
npx wrangler deploy
```

---

## 7. 优先级规则

```
环境变量 (Dashboard / wrangler.toml)
        │
        ▼  存在且解析成功？
      ┌───┐
    YES │  │ NO
        └───┘
         │     │
         ▼     ▼
    使用环境变量    使用代码中的 DEFAULT_* 常量
    的值             (硬编码默认值)
```

**具体行为：**

- 环境变量**存在且能正确解析** → 使用环境变量的值
- 环境变量**不存在** → 回退到代码中的 `DEFAULT_*` 硬编码值
- 环境变量**存在但解析失败**（如 `REPLACE_DICT` 传了非 JSON 字符串） → 也回退到硬编码值，不会崩溃

---

## 8. 配置示例汇总

### 场景 A：完全通过代码配置（不设环境变量）

代码中直接改：

```javascript
const DEFAULT_BLOCKED_REGION = ["KP", "SY"];
const DEFAULT_BLOCKED_IP_ADDRESS = ["10.0.0.1"];
const DEFAULT_REPLACE_DICT = { "旧文本": "新文本" };
const DEFAULT_SPECIAL_CASES = { "*": { "Origin": "DELETE" } };
```

部署后即生效，Dashboard 中不需要添加任何环境变量。

### 场景 B：通过环境变量覆盖（不改代码）

代码中保持所有 `DEFAULT_*` 为空，在 Dashboard 添加：

| 变量名 | 值 |
|--------|-----|
| `BLOCKED_REGION` | `["KP","SY"]` |
| `BLOCKED_IP_ADDRESS` | `10.0.0.1` |
| `REPLACE_DICT` | `{"旧文本":"新文本"}` |
| `SPECIAL_CASES` | `{"*":{"Origin":"DELETE"}}` |

### 场景 C：混合使用

代码中设定开发环境默认值，生产环境通过环境变量覆盖。例如代码中设 `DEFAULT_BLOCKED_REGION = []`（不屏蔽），生产环境 Dashboard 设 `BLOCKED_REGION = ["KP","SY"]`（屏蔽特定地区）。
