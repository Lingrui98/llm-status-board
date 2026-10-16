# R21 终审报告（主体）—— 暂停能力移除 + 刷新入口同源

范围：task-48（Rust 移除暂停）、task-49（前端移除暂停 + 入口核对）、task-51（托盘刷新改事件链路）、task-53（前端 settled 回报）。**状态：主体已核完；因新增 task-54（看门狗）待落地，最终结论与最终哈希暂缓**（见 §7）。

## 1. 零残留（机械证据）

- `git grep -n -i -e pause -e 已暂停 -- src src-tauri/src` → **3 行，全部在 `src/App.test.tsx`，且都是「断言不存在」的正当命中**：`:1305` 用例名「R21：暂停能力已移除…」、`:1328` 注释「不再有 pause 类 IPC」、`:1330` `expect(calledCommands.some(c => c.includes("pause"))).toBe(false)`。**生产代码 0 命中** ✓
- IPC `set_auto_refresh_paused` 与事件 `tray-toggle-pause`：全仓（`src/**` 含 untracked + `src-tauri/src/**`）**0 命中** ✓ → 不会出现「调用不存在命令」的运行时错误（本轮最易漏的回归点）。

## 2. Rust 结构

- 菜单 id 常量全集恰为 6 项 + 账号前缀：`tray-show` / `tray-refresh` / `tray-open-settings` / `tray-quit` / `tray-empty` / `tray-more` / `account:` ✓（暂停项已消失）
- `pub fn tooltip_text(total: usize, failed: usize)` 两参、只反映账号数与异常数 ✓；`fn load_tray_data -> (Vec<AccountConfig>, Vec<RefreshOutcome>)`（不再返回 `auto_refresh_sec`）✓；`pause_menu_item` / `AUTO_REFRESH_PAUSED` / `apply_auto_refresh_paused` 均不存在 ✓
- **R20 未被波及**：`primary_metric.rs` 哈希 `5ddfccafe4ef7f66` = R20 冻结值 ✓（黄金表与口径原样）
- ARM 说明：Lead 任务书写的 `app.listen_global` 是 Tauri v1 API，2.12.2 实为等价的 `app.listen(EVENT_REFRESH_SETTLED, …)`（`tray.rs:274`）→ **记为实现等价，非偏差**。

## 3. 前端结构与行为

- `App.tsx` 无 `autoPaused`/`autoPausedRef`/暂停监听/`set_auto_refresh_paused`（命中 0）✓；自动刷新定时器仅剩 `const sec = …; if (sec > 0) { refreshTimer.current = window.setInterval(() => { void refresh(); }, sec * 1000); }`（`App.tsx:504-506`）—— **无暂停短路**，`sec>0` 即始终按间隔触发 ✓
- `SettingsView.tsx:407/416`：保留「自动刷新间隔（秒，0 = 关闭）」，说明写明「**设为 0 即关闭自动刷新；手动刷新（顶栏 / 总览条 / 托盘 / 本页「刷新数据」）不受影响**」✓；常驻分组无该行 ✓
- **无语义漂移**：`components/ui/InlineNotice.tsx` 仅 `paused → held` 纯改名（state/handlers/依赖数组同名替换，逻辑等价）✓；`refreshRetry.ts` **仅 2 行注释**改动（「暂停」从用法/说明里移除），`refreshRetry.test.ts` **未改动**且 424 全绿 ⇒ **R16 的 4 条重试口径（1s/2s/4s、待执行 ≤1、部分失败不重试、手动/成功取消）零漂移** ✓

## 4. 刷新入口同源（用户点名）

| 入口 | 调用链证据 |
|---|---|
| 顶栏「立即刷新」 | `App.tsx:952 onClick={() => void refresh()}` |
| 总览条「刷新」 | `Dashboard.tsx:190 onClick={onRefresh}` ← `App.tsx:1017 onRefresh={refresh}` |
| 各区块「刷新一次」 | `Dashboard.tsx:262/272 onRefresh={onRefresh}` ← 同上 `refresh` |
| 设置页「刷新数据」 | `App.tsx:1023 onRefresh={handleSettingsRefresh}` → `:625-628 await flushSaveNow(); … refresh()`（前置落盘是唯一差异）|
| 命令面板 | `App.tsx:1041 onRefresh={refresh}` |
| **托盘菜单「立即刷新」** | `tray.rs:297 app.emit(MENU_REFRESH)`（置灰「刷新中…」）→ `App.tsx:403 listen("tray-refresh", () => … refresh())` → 前端同一 `refresh()` → 既有 `refresh_all` IPC；完成后 `App.tsx:327 emitRefreshSettled()` → `tray.rs:274 app.listen(EVENT_REFRESH_SETTLED)` → 重载 results.json + `update_tooltip` + `rebuild_menu(false)` |

- **事件名逐字一致**：`tray-refresh`（`tray.rs:13` ↔ `App.tsx:403`）、`frontend-refresh-settled`（`tray.rs:16` ↔ `refreshEvents.ts:13`）✓
- **无双刷**：`refresh_all` 在 `tray.rs` **0 命中**（仅 `commands.rs:103` 定义、`lib.rs:108` 注册）；前端用例断言「托盘触发 → `refresh_all` 恰 1 次 + settled 恰 1 次 + 结果上屏」✓ → **监听不是死代码**（该用例即证据）

## 5. 门禁与基线（task-54 前中间态）

`tsc` 0｜vitest **424/424**（23 文件，本机）与 **424/424**（TZ=UTC）｜`cargo test` **97 passed / 0 failed / 7 ignored**（**连跑 2 次均 exit 0**）｜clippy exit 0｜fmt exit 0｜`vite build` 成功、主入口 `main-DpZYnys4.js` 133.91 kB（磁盘 145,056 B）、`recharts` 命中 0。
**基线**：非 App 的 12 个口径文件 **237 条断言删除/改动 = 0** ✓；`App.test.tsx` 变化**逐条列出且全部与暂停/R21 相关**：删除/改名 1 条（`§6：托盘暂停事件…`）→ 新增 5 条（`R21：暂停能力已移除…`、`R21① 成功恰 1 次`、`R21② 失败路径恰 1 次`、`R21③ tray-refresh 不双跑`、`R21④ 监听非死代码`），39 → 43 ✓。**Rust `#[test]` 95 → 97**（task-48 改写 4 条、task-51 新增 2 条，无删减）✓

## 6. 越界复核

写者仅 fe-k3（`src/**`：`refreshEvents.ts`、`App.tsx`、`App.test.tsx`、`SettingsView.tsx`、`InlineNotice.tsx`、`refreshRetry.ts` 注释）+ 开发 B（`src-tauri/**`：`tray.rs`、`commands.rs`、`lib.rs`）+ PM（`docs/`）→ **无例外** ✓

## 7. 增量复验（task-54 看门狗）与最终结论

**V-1 缺口与修法（已关闭）**：置灰「刷新中…」后若 `frontend-refresh-settled` 丢失（监听未就绪 / 渲染进程异常或重载 / 事件被吞），原实现 Rust **不自恢复** ⇒ 托盘「立即刷新」永久置灰。task-54 落地：`pub const REFRESH_WATCHDOG: Duration = Duration::from_secs(15)`（`tray.rs:21`）、`static REFRESH_EPOCH: AtomicU64`（`:28`，点击与 settled/settled-claim 均自增）、纯函数 `pub fn watchdog_should_restore(click_epoch, current_epoch) -> bool`（`:32`，**相等才恢复**）、`spawn_refresh_watchdog()`（`:279`，`tauri::async_runtime::spawn` + `tokio::time::sleep`，无新依赖）、**settled 与看门狗超时共用** `restore_tray_after_refresh()`（`:264`，`rebuild_menu(false)` + 重载 results.json 刷 tooltip/账号区，调用点 `:273`/`:290`）→ 菜单最多卡 15s 即自恢复 ✓

**看门狗纯函数独立实测（我自己的临时副本 harness，注入 crate 根测试；被审仓库未改）**：断言 `REFRESH_WATCHDOG == 15s`；`(1,1)/(0,0)` → **恢复**；`(1,2)/(7,8)` → **不恢复**；连续两次点击「第一次让位、最后一次恢复」；恢复认领后代次再前进 → **幂等不重复恢复** → 全部通过（`R21_WATCHDOG_OK`，1 passed / 0 failed）。与仓库 4 条用例（`watchdog_restores_when_no_settled` / `watchdog_skips_when_settled_advanced_epoch` / `watchdog_only_last_click_is_effective` / `watchdog_is_idempotent_after_restore`）互为独立证据 ✓

**最终门禁（同一修订，PRE==POST）**：`tsc` 0｜vitest **425/425**（23 文件，本机）与 **425/425**（TZ=UTC）——含 fe-k3 的 `R21⑤`（在途轮次期间不提前发 settled、在途结束必补发一次）｜`cargo test` **101 passed / 0 failed / 7 ignored**，**连跑两次均 exit 0**（此前的偶发失败未复现，记为环境/锁争用）｜clippy exit 0｜fmt exit 0｜`vite build` 成功、主入口 `main-DpZYnys4.js` 133.91 kB（磁盘 145,056 B）、`recharts` 命中 0。
**基线（最终）**：非 App 的 12 个口径文件 **237 条断言删除/改动 = 0**；`App.test.tsx` 39 → 44（删/改名 1 条暂停用例 + 新增 6 条 R21 用例，**全部与暂停/刷新链路相关**）；Rust `#[test]` 95 → **101**（task-48 改写 4、task-51 新增 2、task-54 新增 4，无删减）✓
**最终哈希（sha256 前 16）**：`primary_metric.rs 5ddfccafe4ef7f66`（= R20 冻结值，未被波及）｜`tray.rs c914b1b5f4223c89`（task-54 后）｜`commands.rs 7867a02d541e1cb5`｜`lib.rs 5a9682cefef1d95b`｜`App.tsx 80adaebc5514e569`｜`SettingsView.tsx 422a57ea3e6ff9ad`｜`App.test.tsx 3a38b64c044211f5`｜`refreshRetry.ts a55539a5e57445c9`｜`api.ts 54c24a2c37599c7c`｜`InlineNotice.tsx 7db572005f773e53`｜`refreshEvents.ts a114d7a046344316`（与开发 B 独立复算的四个 Rust 哈希逐字一致）。
**范围**：task-48/49/51/53/54（task-52 为误建重复任务，由 Lead 删除，不计范围）。

**观察项（不阻断）**：① 偶发 `cargo test` 失败仅出现在并行 cargo 运行窗口，最终连跑两次与随后多次均 **101/0**（记为环境问题）；② `app.listen` ↔ 任务书 `listen_global` 为 Tauri 2 API 等价实现（非偏差，已记 §2）；③ 看门狗属**最坏 15s 兜底**：settled 丢失时菜单最多灰 15s 后恢复（设计如此，已写入发布说明要点）；④ 并发点击安全：仅最后一次点击的看门狗会恢复，在途轮次的 settled 仍会在 finally 补发（`R21⑤` 覆盖）。

**结论：建议推送**。AC（零残留 / 事件名逐字一致 / 无双跑 / 监听非死代码 / 六处刷新入口同源 / 看门狗健壮性）全部通过，V-1 关闭，无未达标项。
