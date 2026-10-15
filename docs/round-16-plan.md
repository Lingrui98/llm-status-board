# R16 常驻与自动化 — 执行规格

目标：让常驻工具长期挂机可用（自启 / 窗口记忆 / 系统通知 / 失败重试 / 托盘增强 / Rust 兜底），**且任何插件失败都不得让应用不可用**。

## 0. 现状事实（侦察结论，实现前必读）

- `capabilities/default.json` 目前只有 `["core:default","dialog:default"]`，`windows:["main"]`。
- `Cargo.toml` 仅 `tauri-plugin-dialog`；`package.json` 已含 `@tauri-apps/plugin-autostart` 与 `@tauri-apps/plugin-notification`（**Rust 侧 crate、window-state 均未装**）。
- `tray.rs`：`TRAY_ID="main-tray"`、菜单项 `tray-show/tray-refresh/tray-quit` + 账号区（`account:{id}`，最多 8 个）；`build_menu(app, refreshing)` / `rebuild_menu` / `update_tooltip`；事件先例 `tray-open-account`。
- `App.tsx`：`refresh()` L227-268（`refreshingRef` 互斥、catch 写 `loadError`、`okCount/failCount`）；自动刷新定时器 L302-312（依赖 `autoRefreshSec`）。
- `tauri.conf.json` 窗口为默认 1180×780、`center:true`，无 `visible/skipTaskbar` 定制。
- R15 已交付：`usageHistory.ts#isEmptyUsageRow`（全空行判定，前端已用）；Rust 侧**无**该过滤（上一轮观察项）。

## 1. 配置契约（Settings 新增 3 字段；沿用 `Option<T> + serde default`）

| Rust（snake_case） | TS（camelCase） | 类型 | None 默认 | 校验（越界拒绝保存） |
|---|---|---|---|---|
| `system_notifications` | `systemNotifications` | `Option<bool>` | `false` | — |
| `refresh_retry_enabled` | `refreshRetryEnabled` | `Option<bool>` | `true` | — |
| `refresh_retry_max` | `refreshRetryMax` | `Option<u32>` | `1` | 0 ≤ x ≤ 3 整数 |

- 旧 `config.json`（无这三字段）必须免迁移加载并按上表默认工作；两端 `validate_settings` / `validateSettings` 同步加 `refreshRetryMax` 范围校验。
- **自启与窗口状态都不进 `config.json`**：自启真值以系统为准（`isEnabled()` 查询），窗口状态由 window-state 插件自持文件保存 —— 避免出现两个真值源（R14 教训：Settings 与系统状态漂移）。
- 抑制表（防打扰）属运行态，存 `localStorage`（键 `lsb-sysnotify`，形如 `{"lowBalance:accId": <epochMs>}`），不进配置。

## 2. A 开机自启（tauri-plugin-autostart）

- 设置页「开机自启」开关：**默认关**（`isEnabled()` 为 false）；打开设置页时查询真实状态，查询中开关禁用。
- 切换：`enable()` / `disable()` → **再次查询 `isEnabled()` 确认**（不做乐观更新）；成功后按实际值渲染。
- 失败降级：`enable()`/`disable()` 返回 Err（系统不支持、无权限、Linux 无桌面项）→ 开关**回置为查询到的真实值** + 显示可读原因（如「当前系统不支持开机自启」）；不得抛出未捕获异常、不得影响其它功能。
- 自启启动 = 普通启动（窗口按 §3 规则显示）；本轮**不新增**静默启动参数。

## 3. B 窗口状态记忆（tauri-plugin-window-state）

- 记忆 `POSITION | SIZE | MAXIMIZED` 三项；**真实退出**（含 `closeToTray=false` 时的 ✕）后重启恢复：位置、尺寸、最大化态一致。
- 与「✕ 隐藏到托盘」协同：`closeToTray=true` 时 ✕ 只 `hide()`（进程存活、托盘在、位置尺寸不变）→ **不视为关闭**；隐藏期间不改状态，仅真实退出时落盘。
- 首次启动无保存状态 → 保持现有 `center:true` + 1180×780。
- 越界降级：启动恢复后若 `window.current_monitor()` 返回 `None`（保存的位置已不在任何显示器上，如拔掉外接屏）→ `center()` 并把尺寸复位为 **1180×780**（不小于 `minWidth/minHeight`）。执行时机必须在 window-state 插件**恢复之后**（见 AC-6 口径澄清的细化判据）。
- 实现建议：仅 Rust 侧 `.plugin(tauri_plugin_window_state::Builder::default().build())` 即自动存取，无需前端 JS API。

## 4. C 系统通知（tauri-plugin-notification，三类，必须防打扰）

- 三类：`lowBalance`（余额不足）、`quotaFull`（配额将满）、`refreshError`（刷新失败）——复用 R14 `notifications.ts` 的现有 `NotificationKind`，**不新增类别**；`recovered` **不推送**。
- 开关：`systemNotifications`（默认 false）。关闭时**不请求权限、不调用发送**。
- 发送内容：标题=类别中文名（`KIND_LABELS`）；正文含账号名与关键数值（余额+阈值 / 窗口+百分比 / 错误原因）；正文长度上限 200 字符（超出截断补「…」）。
- **防打扰三条规则（按下单顺序判定，全部满足才发送）**：
  1. **只推新问题**：该 `problemKey` 本轮从「不存在」变为「存在」才考虑；持续存在的问题不重复推。
  2. **24h 抑制**：`now − lastSentAt(kind:accountId) ≥ 86_400_000ms`（24h）才推；否则跳过。
  3. **速率上限**：近 `RATE_WINDOW_MS = 300_000`（5 分钟）内已发送 `< 3` 条才推；被本条丢弃的通知**不写抑制表、不计入速率计数**（否则会永久占额）。**与规则 1 的交互（明确定义，避免自相矛盾）**：被丢弃后该 `problemKey` 已不再是「新出现问题」，**不补发**（防打扰优先于完整送达）；出窗后**新的**问题通知可正常再发。
- 权限边界：`isPermissionGranted()` 为 false → 仅在用户**开启开关时**调用一次 `requestPermission()`；用户拒绝后不再重复请求，设置页常驻显示「系统通知已被系统拒绝」；发送失败/平台无通知服务（Linux 无守护）→ 捕获并静默降级为应用内通知，不重试、不弹错。
- 工程约束：判定逻辑抽成纯函数（`shouldSendSystemNotification(...)`，输入含 now/state/settings）便于单测；实际发送走薄封装（可注入 mock）。
- 开发模式（未打包）在 macOS 可能不显示系统通知 → 不作为失败判定，AC 以「发送调用次数」判定。

## 5. D 刷新失败自动重试（指数退避）

- 触发条件（**整轮失败**）：`refresh_all` 抛错/返回 Err，**或**（启用账号数 > 0 且 `okCount === 0`）。`okCount > 0` 的**部分失败不重试**（避免放大请求量），仅在 UI 标注异常数。
- 次数与间隔：最多 `refreshRetryMax` 次；第 k 次重试前等待 `1000 × 2^(k−1)` ms → **1s、2s、4s**（max=3 时累计等待 7s）。`refreshRetryEnabled=false` 或 `refreshRetryMax=0` → 不重试。
- 手动刷新交互：任一手动刷新（按钮/定时器/托盘「立即刷新」）**取消待执行的重试并清零退避计数**；**任一时刻最多一个待执行重试定时器**；重试本身不产生新的重试链（重试失败是否再退避一次？→ **不**，一次手动/定时刷新最多触发 `refreshRetryMax` 次重试后停止，由下一轮定时刷新重新开始）。
- 暂停自动刷新（§6）时同样取消待执行重试。
- 可读状态：等待期间在刷新区显示「刷新失败，{Ns} 后重试（第 {k}/{N} 次）」，Ns 逐秒递减；重试成功或取消后清除；不改变 `refreshing` 的既有语义（等待期不算 refreshing）。

## 6. E 托盘增强

- 新增菜单项（顺序：显示看板 / 立即刷新 / **暂停自动刷新⇄恢复自动刷新** / **打开设置** / 分隔线 / 账号区 / 退出）：
  - `tray-toggle-pause`：点击**只 emit 事件**（`tray-toggle-pause`），由前端翻转状态（**前端是唯一真值源**，Rust 不自行翻转，避免两端漂移）；前端随后调用新 IPC `set_auto_refresh_paused(paused)` 回报，Rust 依此重建菜单文本与 tooltip。
  - `tray-open-settings`：点击 → 显示并聚焦主窗口 + emit `tray-open-settings`，前端切到设置视图。
- 状态可辨识：暂停时菜单项显示「恢复自动刷新」，tooltip 追加「 · 已暂停」（与现有「N 个账号 · M 个异常」拼接）。
- 暂停语义：仅停用**定时器**（不再按 `autoRefreshSec` 触发），手动「立即刷新」仍可用；暂停状态**不持久化**（重启即恢复运行态，避免用户忘记恢复导致长期不刷新）。
- 边界：`autoRefreshSec <= 0`（未启用定时刷新）时该项置灰并显示「自动刷新已关闭」。
- 失败降级：`set_menu` / `set_tooltip` 失败保持旧菜单（沿用现有静默降级风格），不影响托盘可用性。

## 7. F Rust 侧全空行兜底

- 在 `config.rs#upsert_usage_history` 写盘前过滤：`cost/requests/tokens/input_tokens/output_tokens/used_total` **六字段全为 null** 的记录删除；**`used_total != null` 的 B2 基准行必须保留**（与 `usageHistory.ts#isEmptyUsageRow` 同一判据）。
- 作用范围：**入批 + 合并后的整账**都净化（整账中的全空行不携带任何信息，删除无信息损失；与 `normalize_usage_currency` 同属「写入时净化」）。
- 前端过滤保留（双保险）；幂等不受影响（净化后内容相同 → 仍走「文本全等不写盘」）。

## 8. 权限 / 能力清单（供开发 B 落地）

- Rust 依赖：`tauri-plugin-autostart = "2"`、`tauri-plugin-notification = "2"`、`tauri-plugin-window-state = "2"`；`lib.rs` 注册：`autostart::init(MacosLauncher::LaunchAgent, None)`、`notification::init()`、`window_state::Builder::default().build()`（**注册失败不得 panic**）。
- npm：`@tauri-apps/plugin-autostart`、`@tauri-apps/plugin-notification`（已装）；window-state 纯 Rust 使用则**无需** JS 包。
- `capabilities/default.json` 的 `permissions` 追加：`"autostart:default"`、`"notification:default"`（如需逐条最小化，可写 `autostart:allow-enable` / `autostart:allow-disable` / `autostart:allow-is-enabled` 与 `notification:allow-notify` / `notification:allow-is-permission-granted` / `notification:allow-request-permission`）；**window-state 仅在用其 JS API 时才需 `"window-state:default"`**（推荐纯 Rust，故可不加）。
- 现有 `"core:default"`、`"dialog:default"` 保留；`windows:["main"]` 不变。

## 9. 验收标准（每条指向 §；数值型已笔算，见 §10）

- AC-1 契约默认（§1）：旧 config.json（无 R16 字段）加载成功且三字段为 `false/true/1`；保存后出现 camelCase 键、不出现 snake_case。
- AC-2 校验（§1）：`refreshRetryMax=4` 保存被拒并有可读提示；`0` 与 `3` 通过。
- AC-3 自启即时生效（§2）：`enable()` 后 `isEnabled()=true`、`disable()` 后 `false`；操作**不改 config.json**（真值来自系统）。
- AC-4 自启降级（§2）：模拟 `enable()` 拒绝 → 开关回置实际值 + 可读原因、无未捕获异常、其余功能可用。
- AC-5 窗口恢复（§3）：尺寸 1024×700、位置 (100,80)、最大化 → 真实退出 → 重启后三项一致；状态**不写入** config.json。
- AC-6 越界降级（§3）：`current_monitor()` 返回 None → 启动居中且尺寸复位 1180×780。
  - **口径澄清（2026-10-16，裁决人 Lead）**：判据细化为「`current_monitor()` 为 None **且** `available_monitors()` 非空」才复位。理由：显示器枚举为空通常意味着窗口尚未上屏（启动早期），此时复位会把刚恢复出来的几何冲掉；两个条件同时成立才是真的「保存位置已不在任何显示器上」。实现见 `lib.rs#should_reset_window_geometry`（已有纯函数单测）。
- AC-7 托盘协同（§3）：`closeToTray=true` 时 ✕ → 隐藏、进程存活、位置尺寸不变；`false` 时 ✕ → 退出且状态已保存。
- AC-8 通知默认关（§4）：`systemNotifications=false` → 发送调用数 **0**（即使三类问题同时存在）。
- AC-9 三类都发（§4）：开启后 lowBalance/quotaFull/refreshError 各发送 1 次，正文含账号名与关键数值，超 200 字符被截断。
- AC-10 24h 抑制（§4）：同一 `(accountId,kind)` 首次发送后 **+23:59:00 不发**、**+24:00:00 发**。
- AC-11 速率上限（§4）：5 分钟窗口内第 4 条被丢弃且**不写抑制表**、**不补发**；出窗后新的通知可再发（笔算见 §10）。
- AC-12 只推新问题 + 不推恢复（§4）：`problemKey` 持续存在不重复推；`recovered` 发送数 0。
- AC-13 权限降级（§4）：未授权/被拒 → 发送数 0、无异常抛出、设置页显示「被系统拒绝」、每次开启开关最多请求权限 1 次。
- AC-14 重试间隔（§5）：max=1 → 等待 1000ms 重试 1 次；max=3 → 1000/2000/4000ms（累计 7000ms）；成功即停；开关关或 max=0 → 不重试。
- AC-15 触发条件（§5）：IPC Err 或（启用账号>0 且 okCount=0）触发；`okCount>0` 的部分失败不触发。
- AC-16 手动刷新交互（§5）：待重试期间手动刷新 → 取消定时器、退避归零；任一时刻待执行重试 ≤ 1；重试失败不产生二次重试链。
- AC-17 状态可读（§5）：等待期显示「刷新失败，Ns 后重试（第 k/N 次）」且逐秒递减；成功/取消后清除。
- AC-18 托盘暂停/恢复（§6）：点击后菜单文本与 tooltip 变为可辨识的暂停态；注入假定时器断言暂停期内触发 **0** 次；恢复后重新按 `autoRefreshSec` 计时；暂停不持久化；`autoRefreshSec<=0` 时置灰。
- AC-19 托盘打开设置（§6）：点击 → 窗口显示并切到设置视图（事件 `tray-open-settings`）。
- AC-20 兜底（§7）：直接向 `upsert_usage_history` 传全空行（绕过前端）→ 落盘后文件内**无**全空行；`used_total!=null` 的基准行**保留**；重复 upsert 幂等不变。
- AC-21 能力与不崩（§8）：capabilities 含 autostart/notification 权限；插件 init 失败不 panic；`cargo test` 与 `npm test` 全绿（含既有基线不回归）。

## 10. 自查（AC→§ 对照 + 数值笔算）

**AC→§**：AC-1/2→§1；AC-3/4→§2；AC-5/6/7→§3；AC-8/9/10/11/12/13→§4；AC-14/15/16/17→§5；AC-18/19→§6；AC-20→§7；AC-21→§8。**无孤儿 AC，无与 § 冲突的 AC。**

**数值笔算**：退避 `1000×2^(k−1)` → k=1,2,3 得 `1000/2000/4000ms`，累计 `7000ms` ✔（AC-14）。24h `86_400_000ms`：`t0+23h59m = 86_340_000 < 86_400_000` 不发、`t0+24h = 86_400_000` 达标发 ✔（AC-10）。速率 `RATE_WINDOW_MS=300_000`、上限 3：t=0/60s/120s 发 3 条 → t=180s 第 4 条被丢弃（不计数）→ t=300s 时窗口内仅 t=60s/120s 两条（t=0 已出窗、180s 未计数）→ 可发 ✔（AC-11）。标题+正文截断阈值 200 字符 ✔（AC-9）。

## 11. 明确不做的事

- 不做自动更新（updater 涉签名与更新源）、不做托盘动态图标图片生成。
- 不做「自启即静默隐藏到托盘」（自启=普通启动）、不做暂停状态的持久化。
- 不做系统通知的历史列表/分组/点击跳转（点击行为保持平台默认）。
- 不做通知类别的增删（沿用 R14 三类 + 不推 recovered）、不改 R14 阈值口径。
- 不做窗口状态的多实例/多屏记忆（只记住最后一次关闭前的状态）。
- 不改 `usage-history.json` 的数据契约与 IPC 签名（只加§7 的过滤）。

## 12. 变更历史

| 日期 | 变更 | 裁决人 | 说明 |
|---|---|---|---|
| 2026-10-16 | AC-6 口径澄清 | Lead | 越界复位判据细化为「`current_monitor()` 为 None **且** `available_monitors()` 非空」；保留 AC 原文，仅补澄清（避免窗口尚未上屏时把刚恢复的几何冲掉） |
| 2026-10-16 | §8 权限最小化确认 | Lead | `window-state:default` 仅在用其 JS API 时才需；本轮纯 Rust 使用，故不加该权限（Rust 侧插件行为不受 capability 约束），AC-5 的窗口恢复仍成立 |

## 附：建议分工

- 开发 A（前端）：重试状态机（§5）、系统通知判定与发送（§4）、暂停状态与托盘 IPC/事件接线（§6）、设置页新增三项（§1）。
- 开发 B（Rust）：三个插件注册与 capabilities（§8）、托盘暂停/打开设置项与事件（§6）、自启/窗口状态接线与降级（§2/§3）、usage-history 全空行兜底（§7）、Settings 字段与校验（§1）。
- 美工：设置页三处新控件（自启开关、通知开关+权限状态、重试次数）与托盘暂停态的可辨识表达。
