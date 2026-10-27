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
| OpenAI API | `GET /v1/organization/costs` | 本月用量（需 Admin key；OpenAI 不提供 key 级余额） |
| OpenAI 订阅（Codex） | `GET https://chatgpt.com/backend-api/wham/usage` | ChatGPT 登录凭据；订阅窗口的已用/剩余比例及重置时间 |
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

仓库带三个工作流（`.github/workflows/`）：

- **ci.yml**：push / PR 时自动跑前端测试（vitest + tsc + build）与 Rust 检查（fmt / clippy / 单测，Windows + macOS 双矩阵）
- **release.yml**：push 一个 tag（如 `v0.1.0`）自动构建 Windows + macOS（Apple Silicon / Intel）安装包并发布到 GitHub Release；macOS 签名相关变量见工作流注释。配置了更新签名密钥（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 两个 Secrets）后，会额外生成 `latest.json` 与签名文件供软件内一键更新使用（见「使用」第 7 条）
- **nightly.yml**：每天 18:00 UTC（北京时间 02:00）检查主线。只有主线出现新提交时才构建并发布 nightly 预发布版。该工作流复用稳定版的三平台构建和更新签名密钥

> 注意：本仓库根目录就是项目本身（package.json / src-tauri 在根下），工作流按此布局配置。

#### nightly 发布规则

- nightly 使用滚动 prerelease 标签 `nightly`。更新清单固定为 `https://github.com/Lingrui98/llm-status-board/releases/download/nightly/latest.json`。
- nightly 版本号由稳定版基础版本、UTC 日期和 workflow 运行编号组成，例如 `0.2.12-nightly.20261028.25`。
- 发布说明记录对应的主线提交。下次运行根据该记录判断是否有新提交。
- 三个平台的安装包和签名清单全部通过验证后，工作流才发布 nightly。
- 构建失败的提交会在下次运行时重试。滚动 release 重建期间，nightly 更新清单可能暂时不可用。
- GitHub 定时任务可能延迟。维护者也可以通过 workflow_dispatch 手动触发同一检查流程。

详细设计见 [nightly 发布与更新渠道](docs/nightly-update-channels.md)。

## 使用

1. 首次启动 → 「设置」→「添加账号」
2. 选择类型（中转站 / 官方），填站点地址与凭证
3. 「测试连接」验证后保存，回看板即可看到余额卡片
4. 顶栏「立即刷新」或开启自动刷新间隔
5. 访问 OpenAI 等境外接口不通时，在「设置 → 通用设置」里填网络代理（支持 `http://` / `socks5://`，全局生效）
6. 跨设备迁移（比如 Windows 配好后搬到 Mac）：「设置 → 导出配置」得到 JSON 文件，在另一台机器上「导入配置」——设置替换、账号按 ID 合并（**导出文件包含 API Key，请妥善保管**）
7. 一键更新：在「设置 → 关于与更新」选择「稳定版」或「nightly」。切换渠道后会立即检查。点击「立即更新」下载并安装所选版本。Windows 由安装器接管重启，macOS 安装后点「立即重启」。应用默认在启动时静默检查一次。更新包带签名校验。更新检查与数据查询共用网络代理
8. 托盘区域速览：悬停托盘图标弹出「用量总结」浮层，配额账号行下含**每个窗口**（5h / 7d / 1d / 1m 等）的已用直条与重置倒计时；**右下角手柄可拖拽调整浮层大小**（尺寸记忆）。右键菜单保持简洁：账号名 + 主指标状态行，点击直达详情。sub2api 站的日/周/月数字限额会自动转成百分比参与展示（超限 >100% 可见；日限额按自然日 0 点重置，周窗口带重置倒计时）；「设置 → 通用设置 → 限额窗口明细显示」可切换 百分比条 / 原始数字
9. 账号排序：「设置 → 账号管理」中拖动每行左侧的六点手柄，直接移到目标位置，松手后自动保存并同步看板顺序。拖到页面边缘会自动滚动，`Esc` 或拖出列表取消。键盘操作：聚焦手柄后，空格拿起、上下键移动、空格放下、`Esc` 取消；排序失败时使用顶部保存状态旁的「重试」。

### AiHubMix 余额与累计用量

在「设置 → 添加账号」中选择 **AiHubMix**，站点地址保持 `https://aihubmix.com`（无需添加 `/v1`），填入 AiHubMix API Key 后点击「测试连接」。请求通过 `Authorization: Bearer <API Key>` 认证。

- `GET /dashboard/billing/subscription` 返回 `hard_limit_usd`：总额度，单位美元。
- `GET /dashboard/billing/usage` 返回 `total_usage`：累计已用额度，单位**美分**；查询不附加月份或日期筛选。
- 余额（USD）= `hard_limit_usd - total_usage / 100`。应用同时展示总额度与换算后的累计已用额度；超额使用时保留负余额。

在账号「详情」中可查看「余额趋势」与「总额度趋势」。总额度取每次成功刷新的 `hard_limit_usd`，积累两次记录后显示曲线；额度不变时显示平线，充值或额度调整后显示阶梯变化。历史记录没有总额度的部分不会补填。

这两个接口不提供按日、按模型或 Token 明细；趋势数据仅来自本地刷新记录，不能查询添加账号之前的历史。

### 历史曲线与时间范围

账号详情的余额、总额度曲线共用时间范围，可选择 **1小时 / 24小时 / 7天 / 30天 / 全部 / 自定义起止时间**，默认显示全部已有记录。全局余额趋势也提供相同筛选。预设时间范围以当前时间为终点，日期时间按本机时区显示；界面会注明实际已有记录的起止时间。

曲线横轴按真实时间间隔绘制。余额用直线连接实测点，总额度用阶梯线；超过 6 小时未采样的区间不连线。图上的时间是本地查询采样时间，不是每笔消费发生的时间。

余额历史按账号分别保留 **最近 90 天、最多 150,000 条**，不再由全部账号共享 2,000 条上限。按每分钟一条计算，单账号 90 天约 129,600 条；更高频采样可能先达到条数上限。金额不变的成功查询也记录时间，重复的同一采样点去重。大量历史仅在绘图时减少点数，保留首末值和极值；原始记录仍按上述期限与条数保存。未采集或已清理的数据无法补回。

每日消费账本独立于曲线保留策略：成功刷新先原子保存消费增量和处理基准，再清理旧快照，淘汰部分日期的曲线不会覆盖整日累计。重复刷新和重启不会重复入账；账本写入失败时保留未裁剪快照并提示，后续刷新可重试。升级时保留旧账本已有累计；已被旧版本覆盖且原始快照已清理的金额无法保证恢复。消费仍是本地余额差分估算，不能代替提供商账单。同一账号同一天的账本只保存一种币种，切换币种不会改写或混加已有日累计。

### 官方提供商：ChatGPT 订阅中的 Codex 额度

新增账号时选择 **OpenAI 订阅（Codex）**。Plus、Pro、团队等账号可显示服务端实际返回的 5 小时、每周、代码审查或其他模型窗口：已用比例、剩余比例和重置时间。额外 Credits 单独展示，不折算为美元。窗口缺失时显示说明，不推算成 0% 已用或无限额度。

主卡优先显示 Codex 周额度剩余，代码审查和特定模型额度分别展示；Pro 仅返回周窗口时只显示周窗口。卡片底部显示当前记录段的小趋势图，详情页提供额度窗口选择、已用/剩余百分比切换，以及本周期、24 小时、7/30/90 天、全部和自定义时间范围。订阅详情不显示金额占位行或余额、总额度空图。

额度历史按实际刷新时间采样，采用真实时间轴和阶梯线；不会固定按周一或每七天分段。用量回落、重置时间明显变化、窗口中断恢复都会断开曲线，并用不同文案标记：仅有回落时标为「可能重置或调整」，仅改变重置时间不等同于确认重置。重置时间的 60 秒内抖动与微小浮点误差有容差，判断基准固定，避免连续漂移掩盖真实变化。离线超过 6 小时处不连线；标记对应首次观测时间，无法恢复采样间多次或完全不可见的额外重置。

百分比快照独立保存在应用配置目录的 `quota-history` 中，按真实工作区和额度窗口隔离，不参与美元日消费账本。每账号保留 90 天、最多 15 万次采样（一次采样含全部返回窗口），绘图另行抽样且不会跨分段连线；30 秒内窗口内容不变时不重复写盘，窗口变化和重置边界仍立即记录。分段基准与快照原子保存，淘汰早期记录不会重算或更改分段。成功刷新后开始积累，旧数据不补造。窗口身份按服务端时长识别，不把 primary/secondary 固定解释成 5 小时/每周；令牌续期不改变同一工作区的历史归属。

三种凭据方式任选一种：

- **浏览器登录（推荐，无需安装 Codex）**：点击「使用 ChatGPT 登录」，在本机浏览器完成官方授权后返回面板，测试连接并保存。浏览器未打开时可重新打开或复制登录链接；必须在运行看板的同一台电脑完成，5 分钟后超时。使用 PKCE 和随机 state，仅监听 `127.0.0.1` 的 1455 端口，占用时尝试 1457；两个端口均被占用会提示重试，不会停止其他程序。
- 面板独立管理浏览器登录凭据，查询前自动刷新即将过期的令牌，遇到 401 最多刷新重试一次。凭据保存在应用配置目录的 `chatgpt-auth` 下，本机文件保存（macOS/Linux 目录 `0700`、文件 `0600`，Windows 继承当前用户应用目录权限），令牌不经过前端，也不写入配置导出。浏览器登录引用和本机登录文件路径不会随配置导出或导入，迁移后需要重新登录或重新选择文件。「断开登录」或删除账号后保存会删除不再被其他账号引用的本机凭据，不会登出浏览器或本机 Codex。
- **已有本机登录文件**：可选择 `codex login` 生成的 `auth.json`。默认路径为 macOS 的 `~/.codex/auth.json`、Windows 的 `%USERPROFILE%\.codex\auth.json`；设置 `CODEX_HOME` 时在该目录中选择。应用只保存所选路径，每次刷新重新读取 `tokens.access_token` 与 `tokens.account_id`，不扫描其他凭据、不修改文件，也不复制令牌到看板配置。
- **手动令牌**：填写自己的 ChatGPT Access Token；团队多工作区可填写对应的 ChatGPT Account ID。API 平台的 `sk-` Key 和 Admin Key 无法查询订阅额度。手动令牌随看板配置保存，导出配置时同样需要妥善保管。

本功能参考[官方 Codex 用量请求](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)及[登录文件结构](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)。用量仅通过 GET 查询，登录与续期向授权端点 POST，不调用模型。它监控 Codex 配额，不涵盖 ChatGPT 网页聊天消息额度，也不提供订阅的每日美元费用或精确剩余消息数。

外部登录文件使用系统钥匙串而不包含 `tokens` 时，可改用面板的浏览器登录。外部文件/手动 Access Token 到期后仍需在 Codex 刷新会话或重新登录；看板只自动续期自己创建的浏览器登录，避免干扰其他客户端的刷新令牌。授权采用[官方公开的原生客户端流程](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)，不提供自定义授权服务器，不要求输入 ChatGPT 密码。用量接口与授权参数可能随官方客户端变更；面板的令牌请求和用量查询使用通用代理设置，浏览器遵循自身网络设置。

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
