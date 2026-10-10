# LLM Status Board

一个 Win / macOS 双平台的桌面小工具：把你手头所有 LLM API 提供商（官方 + 中转站）的**余额与用量**聚合到一块看板上。

![tech](https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React-blue)

## 支持的提供商

### 中转站

| 类型 | 查询方式 | 凭证 |
|---|---|---|
| one-api / new-api 系（含 one-hub / veloera / done-hub 等） | `/api/user/self` + `/api/log/self/stat`（今日消费） | 访问令牌（推荐）或 API Key |
| sub2api | API Key 走 `/v1/usage`（一次拿全）；或账号密码 / token 走面板 API | 三选一 |
| ModelServer（如 code.cs.ac.cn 拼车面板） | refresh_token → 项目钱包余额 + 订阅窗口 | refresh_token |
| 自定义 HTTP | 任意一个 HTTP 请求 + JSON 点路径提取 | 任意 header / body 占位符 |

### 官方

| 提供商 | 接口 | 说明 |
|---|---|---|
| DeepSeek | `GET /user/balance` | 充值/赠送余额，CNY/USD |
| OpenAI | `GET /v1/organization/costs` | 本月用量（需 Admin key；OpenAI 不提供 key 级余额） |
| SiliconFlow 硅基流动 | `GET /v1/user/info` | 总余额/充值/赠送，币种按域名（.cn=CNY） |
| Moonshot / Kimi | `GET /v1/users/me/balance` | 可用/现金/代金券余额（官方接口） |
| 智谱 GLM | 控制台内部接口 | 可用余额/累计消费，CNY（非官方 API，有变动风险） |
| 阿里云百炼 | — | sk- key 无余额接口（计费在阿里云主账号），卡片会显示说明 |

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://rustup.rs/)（MSVC 工具链）
- Windows: WebView2（Win10/11 自带）；macOS: Xcode Command Line Tools

### 开发调试

```bash
npm install
npm run tauri dev
```

### 测试

```bash
npm test                 # 前端 UI 测试（vitest + jsdom，无需 GUI）
cd src-tauri && cargo test                      # Rust 单元测试
cd src-tauri && cargo test -- --ignored        # 真实网络集成测试（需联网）
```

### 构建安装包

```bash
npm run tauri build
```

Windows 出 NSIS 安装包（`src-tauri/target/release/bundle/nsis/*.exe`）；
macOS 出 `.app` / `.dmg`（需要 Mac 上构建或用下方 CI）。

### macOS 构建（GitHub Actions）

仓库带 `.github/workflows/release.yml`：push 一个 tag（如 `v0.1.0`）即可自动构建 Windows + macOS 安装包并发布到 GitHub Release。签名相关变量见工作流注释。

## 使用

1. 首次启动 → 「设置」→「添加账号」
2. 选择类型（中转站 / 官方），填站点地址与凭证
3. 「测试连接」验证后保存，回看板即可看到余额卡片
4. 顶栏「立即刷新」或开启自动刷新间隔
5. 访问 OpenAI 等境外接口不通时，在「设置 → 通用设置」里填网络代理（支持 `http://` / `socks5://`，全局生效）

### 凭证怎么填（以中转站为例）

- **one-api / new-api 系**：登录站点 → F12 → Network/Application → 找到请求里的 `Authorization: Bearer xxx` 里的 `xxx`（站点访问令牌，非 sk- key）；new-api 还需要用户 ID（「New-Api-User」请求头里的数字）。
- **sub2api**：最简单——填 `sk-` 开头的 API Key 即可（走 `/v1/usage`）。
- **ModelServer**：登录面板 → F12 → Application → Local Storage → `refresh_token` 的值。

所有凭证只保存在本机配置文件（见设置页顶部显示的路径），查询请求直连各提供商。

## 安全说明

- API Key / Token 仅存本机 `config.json`（应用配置目录），随用随取，不经过任何第三方服务器。
- 原始响应 JSON 可在卡片里展开查看，便于排查字段问题。

## License

MIT
