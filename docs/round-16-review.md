# R16 终审报告：常驻与自动化（对照 `docs/round-16-plan.md` AC-1..21）

方法：全量 `git diff` 通读 + **独立复算**（esbuild 打包真实模块 → Node 探针，期望值自备；插件包保持 `external` 以**真实复现「插件不可用」**）+ **独立 Rust harness**（临时副本注入自写测试）+ 全套门禁。探针与副本已删，**被审仓库零修改**。

## 0. 实测结果（门禁前后哈希 **PRE==POST**，期间无写入）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test`（本机 / `TZ=UTC`） | **329/329**（17 文件）双时区全绿 |
| `npx vite build` | 成功；入口 chunk `index-CG8gzYXn.js` 287 KB，`recharts-` 命中 **0**；插件被拆成独立小 chunk（`index-DIMXKoq2.js` 0.26 KB）→ 动态 import 未污染主入口 |
| `cargo test` | **68 passed / 0 failed / 7 ignored** |
| `cargo clippy --all-targets -- -D warnings` / `cargo fmt --check` | 均 exit 0 |
| 基线 | R15 冻结的 13 个测试文件对照 HEAD：**253 条断言，删除/改动 = 0**（`App.test.tsx` +17 新增） |

## 1. AC-1..AC-21 判定

| AC | 判定 | 证据 |
|---|---|---|
| AC-1 | 通过 | 探针：`resolveRetrySettings(undefined/旧配置)` → `{enabled:true,max:1}`、`isSystemNotifyEnabled(undefined)=false`；Rust `r16_legacy_settings_without_new_fields_are_none` / `r16_settings_fields_round_trip_camel_case`（无 snake_case） |
| AC-2 | 通过 | Rust：边界 0/3/None 通过、`4` 被拒且错误含范围；TS `validateSettings` 同步拒绝（`SettingsView.tsx` L68-71）；探针：手改非法 5 → 解析回退 1 |
| AC-3 | 通过 | 探针 `toggleAutostart` 成功路径；`handleToggleAutostart` 只改本地状态、**不写 config**（`SettingsView` 未走 `updateSettings`）；能力含 `autostart:default` |
| AC-4 | 通过 | 探针：`enable` 抛错 → `ok:false` + 「当前系统不支持开机自启」；`enable` 不报错但系统未生效 → **被发现**（「系统未接受开机自启设置」）；查询失败 → 保守回置 |
| AC-5 | **无法验证（真机）** | 静态证据齐备：`window-state` 插件已注册（`lib.rs` L63，默认 flags=POSITION/SIZE/MAXIMIZED）、crate 2.5.0 已装、纯 Rust 路径不需要 capability。**本机因用户实例占用 WebView2 无法冒烟**，故重启恢复行为留待打包后手工确认 |
| AC-6 | 通过（口径澄清） | `should_reset_window_geometry`（`lib.rs` L19-24）纯函数 + 4 组单测；守卫插件注册在 `window-state` **之后**（L66，注释说明 `on_window_ready` 顺序）。判据已按 §12 澄清为「None 且 available_monitors 非空」 |
| AC-7 | 通过（代码级） | `tray::on_close_requested` 与 `closeToTray` 协同逻辑未变（R14 基线）；window-state 在真实退出时落盘。真机 ✕ 行为无法冒烟（同 AC-5） |
| AC-8 | 通过 | 探针：`enabled:false` 时不发送；`App` 未开启时**提前 return**且仍记录问题快照（`App.tsx` L704-710）——避免重新开启时把旧问题误判为新问题 |
| AC-9 | 通过 | 探针：三类（lowBalance/quotaFull/refreshError）判定通过、`recovered` 被 `notSystemKind` 排除；正文含账号名 + 数值、>200 字符截断且以「…」结尾 |
| AC-10 | 通过 | 探针：`now−last = 86_399_999` → `suppressed`；`= 86_400_000` → 发送 |
| AC-11 | 通过 | 探针：窗口内已 3 条 → 第 4 条 `rateLimited`；出窗后可发；**被丢弃的不写抑制表、不计入速率**（`commitSystemNotify` 未被调用），且下一轮因规则①不再补发 |
| AC-12 | 通过 | 探针：`prevProblemKeys` 含该 key → `notNew`；`active:false` → 不推；`recovered` → 不推。`App` 用 `prevSystemProblemKeys` 快照算 `newKeys`（L713-715） |
| AC-13 | 通过 | 探针：查询权限抛错 → `{sent:false,permission:"unknown"}`；已拒 + allowRequest → **只请求 1 次、不发送**；发送抛错不冒泡；`App` 在 `notGranted` 时 `break` 不再骚扰（L759-761） |
| AC-14 | 通过 | 探针：`retryDelayMs` = 1000/2000/4000/8000，累计 `1000+2000+4000=7000`；链上实发 `[1,2,3]` 后 `schedule()` 返回 false；`enabled=false` 或 `max=0` → 从不安排 |
| AC-15 | 通过 | 探针 4 组：IPC Err→重试；全失败（ok=0,n>0）→重试；**部分失败（ok=1）→不重试**；无启用账号→不重试 |
| AC-16 | 通过 | 探针：重复 `schedule()` 第二次返回 false（**待执行 ≤1**）；`cancel()` 清定时器 + 计数归零、之后重新从 1s 开始；`App` L347（成功即取消）、L805-809（暂停即取消） |
| AC-17 | 通过（代码级） | `pendingInfo.remainingSec` 上取整（探针：剩 600ms → 1s）；`App` 500ms ticker 刷新倒计时（L384）+ 文案渲染（L922） |
| AC-18 | 通过 | 探针（Rust 纯函数）：`pause_menu_item(0,_)` → (「自动刷新已关闭」,false)、`(300,false)` → 「暂停自动刷新」、`(300,true)` → 「恢复自动刷新」；`tooltip_text` 暂停时保留异常摘要并追加「 · 已暂停」。前端：定时器内 `if (autoPausedRef.current) return`（L508-509）、手动刷新不受限、状态不持久化 |
| AC-19 | 通过 | Rust emit `tray-open-settings` ↔ `App.tsx` L426 `listen(...) => setView("settings")`（事件名与菜单 id 常量一致，`tray.rs` L542-543 单测锁定） |
| AC-20 | 通过 | **独立 harness**：入批全空行被丢弃、`used_total!=null` 的 B2 基准行保留（`usedTotal=500, cost=0`）、`requests=0`/`tokens` 有值也保留；整账历史全空行写入时被清除；净化后**字节幂等**；只含全空行且无文件 → 不创建空文件 |
| AC-21 | 通过 | 权限 id 实核（见 §3）；插件缺失下 `toggleAutostart`/`sendSystemNotify` 均**不抛、不白屏**（探针真实动态 import 失败路径）；cargo 68 / vitest 329 / clippy / fmt 全绿 |

## 2. 跨端 / 跨插件契约

- **Settings 三字段**：`system_notifications↔systemNotifications`、`refresh_retry_enabled↔refreshRetryEnabled`、`refresh_retry_max↔refreshRetryMax`（`types.rs` L156-162 / `types.ts`），均 `Option + serde default`，默认 `false/true/1`；Rust 往返测试断言磁盘只出现 camelCase。
- **IPC**：`set_auto_refresh_paused(app, paused) -> Result<(), String>`（`commands.rs`）↔ `invoke("set_auto_refresh_paused", { paused })`（`api.ts`）✓，已注册 `lib.rs` L88。
- **事件/菜单 id**：`tray-toggle-pause`、`tray-open-settings` 两端一致 ✓。
- **权限 id 与已安装 crate 实核（重点）**：`autostart-2.7.0/permissions/default.toml` = `[allow-enable, allow-disable, allow-is-enabled]` → `autostart:default` 有效且覆盖前端三个调用；`notification-2.7.0` 的 default 含 `allow-is-permission-granted / allow-request-permission / allow-notify` ✓；`window-state-2.5.0` 的 default 为 JS API 权限，本轮纯 Rust 未用 → **不加正确**。`capabilities/default.json` = `core:default + dialog:default + autostart:default + notification:default` ✓ **无拼写错**。

## 3. 降级路径实测（本轮特色）

1. **插件不可用**：探针保持插件包 external + Node 下真实 import 失败 → `toggleAutostart` 返回可读错误、`sendSystemNotify` 返回 `{sent:false}`、`sendNotification` fire-and-forget **无同步异常** → 不白屏、不 panic ✓。
2. **通知权限被拒**：只请求一次、不发送、不抛错；手动放行文案如实（「重新请求授权」+ 系统设置路径），不谎称能跳转设置页 ✓（`pluginRuntime.ts` L63-84）。
3. **系统不支持自启**：可读中文 + 开关回置真实值 ✓。
4. **窗口越界**：纯函数判定 + 守卫插件在恢复后执行，失败静默 ✓。
5. **刷新主流程不受影响**：通知/自启/托盘/用量历史全部为「捕获 + 提示」路径，`refresh()` 的 try/catch 结构未被改动 ✓。

## 4. 无障碍判定（SettingRow「重试次数」行）

- `ThresholdSlider` 内部：range 输入有 `aria-label="自动重试次数上限"`，number 输入有组件自带 `<label htmlFor>` → **两个控件都能取得无障碍名**，与行标签同文案 ✓。
- `SettingRow` 该行用普通 ReactNode 控件、无 `htmlFor` → 行标签渲染为 `<span>`（**无悬空 htmlFor**，不产生错误关联）。**判定：合格**（读屏可取得名字；仅标签元素语义弱一级）。
- 可选改进（非阻断）：改用 render-prop 透传 `aria-describedby`，让 hint「0–3 次，间隔 1s / 2s / 4s」也被读屏关联。

## 5. 开发 B 三处偏差判定

1. **未实现自启 IPC** → **可接受**：规格 §2 只要求前端调插件 API，能力已放行；额外汇总 IPC 无收益，AC-3/AC-4 仍成立。
2. **窗口越界兜底保守化** → **可接受**：已落笔 AC-6 口径澄清（且区分「尚未上屏」误判是正确工程判断）。
3. **移除 `window-state:default`** → **可接受且正确**：纯 Rust 路径不受 capability 约束，窗口恢复不受影响；AC-5 仍以真机冒烟为最终判据（本轮无法执行）。

## 6. 越界复核与缺陷

- **越界：无例外**。美工 `ui/**`（SettingRow/InlineNotice + index + styles.css）；开发 A `src/**`（App/api/types/SettingsView/6 个新模块）；开发 B `src-tauri/**` + 根 `package.json`/`package-lock.json`（插件依赖，任务书明确授权）；PM `docs/`。
- **D-1（次要）** `shouldSendSystemNotification` 在开关关闭时返回 `skipReason:"notNew"`（`systemNotify.ts` L125），语义应为 `disabled`；仅影响调试可读性，行为正确。
- **D-2（次要）** `App.tsx` L400-407 在 `setAutoPaused` 的**更新函数内**调用 `api.setAutoRefreshPaused`（副作用入 reducer）；StrictMode 下更新函数可能执行两次 → 重复 IPC（同值、幂等，无实际危害）。建议把 IPC 移到 `useEffect([autoPaused])`。
- **D-3（观察）** 窗口恢复 / ✕ 隐藏 / 托盘点击三项**无法本机真机验证**（WebView2 实例占用）；建议打包后按 AC-5/AC-7/AC-18 做一次手工冒烟。
- **D-4（观察）** 无障碍：见 §4，合格但可加强 hint 关联。
- **D-5（观察）** `resolveRetrySettings` 对非法 `max`（如 5）静默回退 1，而保存路径会拒绝 → 两者不矛盾（都不接受 >3）。

## 7. 结论

**建议推送**。AC-1..AC-4、AC-6、AC-8..AC-21 均有独立复算证据；AC-5、AC-7、AC-17、AC-18 的真机交互面为「代码级 + 纯函数级」验证（本机无法冒烟，已如实标注）；无阻断缺陷，D-1/D-2 为次要、D-3/D-4/D-5 为观察项。**推送前建议**：按 D-3 清单在打包后手工冒烟一次窗口恢复 / ✕ 隐藏 / 托盘暂停三项（不影响推送，属最终确认）。
