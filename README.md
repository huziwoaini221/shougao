# manuscript-web — 个人手稿分卷档案 Web 系统

> 网页负责管理，Cloudflare 负责入口和安全，GitHub Private Repository 负责长期保存；每个仓库控制在 400 MB 左右，并自动分卷。

架构、规则与交互设计见 `../项目方案_最终版.md`。

## 目录

```
manuscript-web/
├── worker.js                 # Worker 入口：API 路由 + Static Assets
├── wrangler.toml             # Cloudflare 配置
├── manifest/schema.json      # manifest.json 数据结构定义
├── public/                   # 前端（HTML + CSS + 原生 JS）
│   ├── index.html
│   ├── style.css
│   └── app.js
└── src/
    ├── auth.js               # 认证（Cloudflare Access / APP_TOKEN 可选）
    ├── config.js             # /api/config
    ├── github.js             # GitHub REST API 封装（Git Trees/Commits 一次提交）
    ├── http.js               # 响应工具
    ├── image.js              # /api/image 私有仓库图片代理
    ├── submit.js             # /api/submit 提交手稿（编号/分卷/提交）
    └── sync.js               # /api/catalog、/api/manifest、/api/status
```

## 环境配置

### vars（wrangler.toml 或 Dashboard）

| 变量 | 说明 | 默认 |
| ---- | ---- | ---- |
| `OWNER` | GitHub 用户名或组织 | 必填 |
| `REPO_PREFIX` | 分卷仓库前缀 | `manuscript` |
| `WEB_REPO` | 网页/索引仓库 | `manuscript-web` |
| `IMAGE_MAX_EDGE` | 前端图片压缩长边像素（避免过度压缩） | `1920` |
| `IMAGE_QUALITY` | JPEG 质量 | `0.82` |
| `THRESHOLD_MB` | 自动切换下一卷阈值 | `380` |
| `HARD_CAP_MB` | 单卷硬上限 | `400` |

### secrets

```bash
wrangler secret put GH_TOKEN
```

- `GH_TOKEN`：GitHub **Fine-grained Personal Access Token**，只授予 `manuscript-web` 与 `manuscript-*\d` 仓库的 Contents 读写权限（批量创建时还需 Repositories 创建权限）。
- `APP_TOKEN`（可选）：额外一层应用 Token，前端请求 `/api/submit` 时需带相同值，可在 `app.js` 配置或在 Cloudflare Access 之后启用。
- 建议在 Cloudflare 侧启用 **Access** 做网页登录认证，作为第一层保护。

### vars 写入方式

```bash
wrangler secret put APP_TOKEN   # 可选

# vars 在 wrangler.toml 中已写好，也可用命令覆盖：
wrangler vars put OWNER your_github_name
```

## 本地开发

```bash
npm i -g wrangler          # 无 npm 时用二进制：https://developers.cloudflare.com/workers/wrangler/install-and-update/
wrangler dev
```

`wrangler dev` 会启动本地 Worker + 静态资源，访问 `http://localhost:8787`。本地会真实调用 GitHub API（需已配置 `GH_TOKEN`）。

## 部署

```bash
wrangler deploy
```

部署后网址即网页入口。可再接入 Cloudflare Access 或自定义域名。

## 仓库初始化

第一次提交手稿时，Worker 会自动：

1. 创建 `manuscript-0001`（private、auto_init）；
2. 在 `manuscript-web` 写入 `data/catalog.json`（总索引）。

之后按 400 MB 分卷自动递增。无需手工建仓（Token 需有仓库创建权限；若不愿给创建权限，可预建 `manuscript-0001` ~ `manuscript-0009`）。

## 数据模型

- 每卷根目录一个 `manifest.json`，记录本卷全部手稿（结构见 `manifest/schema.json`）。
- `manuscript-web` 仓库下的 `data/catalog.json` 是总索引（卷级），只含卷信息，搜索时按卷懒加载 manifest。
- 图片路径：`2026/09/20260923-001-01.jpg`（`年/月/手稿ID-图序号`）。

## 前端交互

- 路由使用 Hash：`#/` 首页、`#/new` 新增、`#/new?draft=xxx` 草稿、`#/edit`（经搜索进入）、`#/search?q=xxx` 搜索、`#/view/{id}?image={n}` 图片定位。
- **保存 ≠ 提交**：保存只写浏览器 LocalStorage；点击「上传提交」才经 Worker → GitHub。
- **搜索结果 → 缩略图 → `#/view/{id}?image={n}`** 三级定位，缩略图为 CSS 缩小原图（v1 不生成真缩略图）。
- 一份手稿 = 一次 Git commit（照片 + manifest 一并提交），GitHub ref 冲突校验避免并发覆盖。

## 已知边界（V1 已接受的取舍）

- 同日跨卷切换时，若极限情况下同日提交多份且正好切换卷，编号序列按卷内重数（重复 ID 不会发生，因为新卷为空；最坏情况是同一日的编号续写而不是全局累计）。
- 缩略图加载原图，缩略流量较大；200 字段为搜索索引文本，不遍历图片。
- 整卷下载未做 zip，需要时用 `git clone` 拉取对应卷即可。