# B站短链转长链工具

将 `b23.tv` 短链还原为真实的 `bilibili.com` 长链，并自动清洗 URL 中的隐私追踪参数。基于 Cloudflare Pages + Functions 构建，零成本部署，无需服务器。

## 功能介绍

**短链转换**

直接粘贴 B 站 App 分享出来的文案，工具会自动从文字中提取 `b23.tv` 短链并还原为真实视频地址。无需手动整理，整段文字粘进去即可。

**追踪参数清洗**

对于已经是 `bilibili.com` 的长链，工具会自动删除以下隐私追踪参数，让分享链接更干净：

`spm_id_from` · `vd_source` · `share_source` · `share_medium` · `share_plat` · `share_session_id` · `share_tag` · `buvid` · `timestamp` · `mid` · `bbid` · `unique_k` 等共 22 个参数

**批量处理**

每次最多支持 50 条链接，多行粘贴，自动并发处理并实时显示进度。

**结果管理**

转换结果按状态着色（绿色成功 / 橙色失效 / 红色错误），支持勾选多条后批量复制，或一键复制全部成功结果。

**深色模式**

支持跟随系统、手动切换浅色 / 深色主题，偏好保存在本地。

## 项目结构

```
├── index.html              # 前端页面（含 CSP 安全策略）
├── app.js                  # 前端逻辑
├── style.css               # 样式（含深色模式）
├── functions/
│   └── api/
│       └── convert.js      # Cloudflare Pages Function（后端 API）
└── package.json
```

## 部署到 Cloudflare Pages

### 前置条件

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费即可）
- 一个 GitHub / GitLab 账号，用于托管代码

### 第一步：Fork 或上传代码

将本项目推送到你自己的 GitHub 仓库。可以直接 Fork，也可以下载后新建仓库上传。

### 第二步：在 Cloudflare Pages 创建项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单选择 **Workers & Pages**
3. 点击 **Create application** → **Pages** → **Connect to Git**
4. 授权并选择你的仓库
5. 填写构建配置：

   | 选项 | 值 |
   |---|---|
   | Framework preset | `None` |
   | Build command | 留空 |
   | Build output directory | `/`（根目录） |

6. 点击 **Save and Deploy**，等待首次部署完成

### 第三步：配置 CORS 白名单（重要）

部署完成后，Cloudflare 会分配一个域名，格式类似 `your-project.pages.dev`。如果你绑定了自定义域名，也需要一并填入。

打开 `functions/api/convert.js`，找到第 11 行的 `ALLOWED_ORIGINS`，将你的实际域名填入：

```js
const ALLOWED_ORIGINS = [
  'https://your-project.pages.dev',
  'https://your-custom-domain.com'   // 如有自定义域名，在此添加
];
```

> **注意**：域名末尾不要加斜杠 `/`，否则 CORS 校验会失败。

修改后提交代码，Cloudflare Pages 会自动重新部署。

### 第四步：绑定自定义域名（可选）

1. 在项目页面点击 **Custom domains**
2. 点击 **Set up a custom domain**
3. 输入你的域名，按提示添加 DNS 记录
4. 等待证书签发（通常几分钟内完成）

### 第五步：配置 Rate Limiting（推荐）

Cloudflare Pages Functions 免费版每日有 10 万次请求的额度。为防止被滥用，建议在 Cloudflare Dashboard 配置速率限制规则：

1. 进入 **Security** → **WAF** → **Rate limiting rules**
2. 新建规则，条件设为路径匹配 `/api/convert*`
3. 阈值建议设为：**同一 IP，60 秒内最多 200 次请求**
4. 超限动作选择 **Block**

> 代码内已内置基于内存的速率限制（120 次/分钟/IP）作为第一道防线，Cloudflare WAF 规则作为第二道防线。

## 本地开发

```bash
# 安装依赖
npm install

# 启动本地开发服务器（需要 wrangler）
npm run dev
```

本地访问 `http://localhost:8788`。

> `npm run dev` 会启动 `wrangler pages dev`，同时模拟 Cloudflare Pages Functions 环境，`/api/convert` 接口在本地也可正常调用。

## 安全说明

本项目在设计上做了以下安全加固：

- **SSRF 防护**：后端严格校验每一跳重定向的目标域名，只允许 `b23.tv` 和 `bilibili.com`，无法被用于探测内网或访问任意 URL
- **HTTPS 强制**：仅接受 `https://` 协议的输入
- **CORS 白名单**：API 只向配置的域名返回跨域头，拒绝未知来源
- **HTTP 方法限制**：仅允许 `GET` 请求
- **URL 长度限制**：输入最长 2048 字符
- **错误信息脱敏**：后端错误不向前端暴露内部细节
- **CSP 策略**：前端页面设置了严格的 Content Security Policy，禁止内联脚本和外部资源加载
- **速率限制**：每 IP 每分钟最多 120 次 API 调用

## 常见问题

**转换结果显示"链接已失效或被拦截"**

该 b23.tv 短链对应的视频可能已被删除、设为私密，或短链本身已过期。

**转换结果显示"跳转目标非 B 站域名"**

极少数情况下 b23.tv 短链会跳转到非 B 站域名（如活动页、第三方合作页），工具出于安全考虑会拒绝此类跳转。

**批量转换时速度较慢**

工具限制了对 b23.tv 的请求频率（2 并发 + 300ms 间隔），以避免触发 B 站风控。50 条链接大约需要 10-15 秒。

**部署后 API 返回 CORS 错误**

检查 `functions/api/convert.js` 中的 `ALLOWED_ORIGINS` 是否包含你的实际域名，且域名末尾没有多余的 `/`。

## License

MIT
