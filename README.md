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
| AiHubMix | `/dashboard/billing/subscription` + `/dashboard/billing/usage`（总额度与累计用量） | API Key |
| 自定义 HTTP | 任意一个 HTTP 请求 + JSON 点路径提取 | 任意 header / body 占位符 |

### 官方

| 提供商 | 接口 | 说明 |
|---|---|---|
| DeepSeek | `GET /user/balance` | 充值/赠送余额，CNY/USD |
| OpenAI | `GET /v1/organization/costs` | 本月用量（需 Admin key；OpenAI 不提供 key 级余额） |
| SiliconFlow 硅基流动 | `GET /v1/user/info` | 总余额/充值/赠送，币种按域名（.cn=CNY） |
| Moonshot / Kimi | 按 Key 前缀自动分流 | `sk-kimi-`（Kimi for Coding 订阅）→ 查订阅额度：5h/7d/月度窗口、并发、加油包；其他 `sk-` → 开放平台余额接口 |
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

Windows 出 NSIS 安装包（`src-tauri/target/release/bundle/nsis/*-setup.exe`）；
macOS 出 `.app` / `.dmg`（需要 Mac 上构建或用下方 CI）。

> **Windows 安装提示**：`setup.exe` 是当前用户（currentUser）安装模式——**保持默认安装路径**（`%LOCALAPPDATA%\LLM Status Board`）无需管理员权限。若手动把路径改到 `C:\Program Files`，需要右键「以管理员身份运行」安装器，否则会报「无法打开要写入的文件」。

### macOS 构建（GitHub Actions）

仓库带两个工作流（`.github/workflows/`）：

- **ci.yml**：push / PR 时自动跑前端测试（vitest + tsc + build）与 Rust 检查（fmt / clippy / 单测，Windows + macOS 双矩阵）
- **release.yml**：push 一个 tag（如 `v0.1.0`）自动构建 Windows + macOS（Apple Silicon / Intel）安装包并发布到 GitHub Release；macOS 签名相关变量见工作流注释

> 注意：本仓库根目录就是项目本身（package.json / src-tauri 在根下），工作流按此布局配置。

## 使用

1. 首次启动 → 「设置」→「添加账号」
2. 选择类型（中转站 / 官方），填站点地址与凭证
3. 「测试连接」验证后保存，回看板即可看到余额卡片
4. 顶栏「立即刷新」或开启自动刷新间隔
5. 访问 OpenAI 等境外接口不通时，在「设置 → 通用设置」里填网络代理（支持 `http://` / `socks5://`，全局生效）
6. 跨设备迁移（比如 Windows 配好后搬到 Mac）：「设置 → 导出配置」得到 JSON 文件，在另一台机器上「导入配置」——设置替换、账号按 ID 合并（**导出文件包含 API Key，请妥善保管**）

### AiHubMix 余额与累计用量

在「设置 → 添加账号」中选择 **AiHubMix**，站点地址保持 `https://aihubmix.com`（无需添加 `/v1`），填入 AiHubMix API Key 后点击「测试连接」。请求通过 `Authorization: Bearer <API Key>` 认证。

- `GET /dashboard/billing/subscription` 返回 `hard_limit_usd`：总额度，单位美元。
- `GET /dashboard/billing/usage` 返回 `total_usage`：累计已用额度，单位**美分**；查询不附加月份或日期筛选。
- 余额（USD）= `hard_limit_usd - total_usage / 100`。应用同时展示总额度与换算后的累计已用额度；超额使用时保留负余额。

在账号「详情」中可查看「余额趋势」与「总额度趋势」。总额度取每次成功刷新的 `hard_limit_usd`，积累两次记录后显示曲线；额度不变时显示平线，充值或额度调整后显示阶梯变化。历史记录没有总额度的部分不会补填。

这两个接口不提供按日、按模型或 Token 明细；趋势数据仅来自本地刷新记录，不能查询添加账号之前的历史。

### 官方提供商：Kimi 订阅（Kimi for Coding）

Kimi 的订阅不在开放平台体系里（开放平台是按量计费），走的是独立的 `api.kimi.com/coding/v1`。本应用按 **Key 前缀自动分流**：

- `sk-kimi-` 前缀（在 www.kimi.com/code/console 生成）→ 订阅模式：展示 5h/7d/月度用量窗口、并发上限、加油包剩余、会员等级
- 其他 `sk-` 前缀（开放平台 key）→ 按量计费模式：展示可用/现金/代金券余额

> 注：订阅额度接口为官方 CLI 背后的未公开文档端点，若 Kimi 侧调整接口结构，展示可能需要跟随更新。

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
