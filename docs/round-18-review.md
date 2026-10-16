# R18 终审 + 复验冻结（对照 `docs/round-18-plan.md` AC-1..AC-15 / M-1..M-6）

方法：独立复算（**Rust harness** 直接调 `summary.rs` 纯函数 + **Node 探针**跑 `summaryData` 纯视图模型）+ 单次全套门禁 + 哈希夹逼。临时 harness/探针已删，**被审仓库零修改**。
**采信 Lead 的真机自动化证据**：构建产物可启动；启动后存在原生标题「用量总结」窗口、300×360（200% 缩放下物理 600×720）、初始 `visible=false` → 窗口创建与配置可用。**悬停本身无法自动触发**（本机托盘图标被 Win11 折叠进溢出区，4 种方式均不稳定）→ M-1..M-6 一律标「**需真机手测**」，不计通过。

## 1. AC-1..AC-15（无 GUI 可验）逐条判定

| AC | 判定 | 独立证据 |
|---|---|---|
| AC-1 状态机定时 | 通过 | Enter→`ScheduleShow` 且 `pending=(Show, 150)`；`due_action(149)=None`、`(150)=ShowNow`；Leave→`(Hide, 1250)`，149/150、249/250 边界全中 |
| AC-2 定时器 ≤1 | 通过 | `pending` 为单个 `Option`；Enter(1000)→deadline 1150，再 Enter(1100)→**替换**为 1250（仅一个）；`Move` 不改显隐与 deadline |
| AC-3 指针取消 | 通过 | 待隐藏期间 `PointerEnter` → `CancelPending` 且 **`visible` 不变**、`pending=None`；`PointerLeave` → 重新 `(Hide, +250)` |
| AC-4 立即隐藏 | 通过 | `Escape/Blur/RowClick/TrayLeftClick/MainFocus` 五者均 `HideNow` + 清定时器（延迟 0） |
| AC-5 四方位选边 | 通过 | 底任务栏→浮层在图标**上方**（`bottom<=icon.y`）；顶→下方；左→右侧；右→左侧；四例均**不与光标相交** |
| AC-6 退侧/clamp | 通过 | 工作区 400×380 放不下 300×360 时，矩形仍**完全落在工作区内**（不越屏） |
| AC-7 scale=2 | 通过 | 返回逻辑坐标，物理 600×720 落在工作区内、不压光标；`NaN` scale 兜底 1.0 不产 NaN |
| AC-8 多显示器 | 通过 | 第二屏 work area（x≥1920 起）→ 矩形 `x≥1919.5`，不越回第一屏 |
| AC-9 窗口配置/能力 | 通过 | `label=summary`/`url=summary.html`/300×360/`decorations:false`/`transparent:true`/`shadow:false`/`alwaysOnTop`/`skipTaskbar`/`resizable:false`/`visible:false`/`focus:false`，**无 `backgroundColor`**；`window-state` `with_denylist(&[POPUP_LABEL])`；`capabilities/summary.json` = `windows:["summary"] + core:default`；`default.json` 哈希与 R17 一致（仍 `["main"]`） |
| AC-10 三态 | 通过 | 探针：空账号→`total=0/rows=0/last="—"`；未刷新→`status=idle`+`valueText="—"`；异常→`detailText`；无余额有窗口→`"76%"` |
| AC-11 内容数值 | 通过 | 行数=**启用**账号（停用号不出行）；`ok/fail/idle=1/1/1`；`usd="$10.50"` 与 `cny="¥0.00"` **分栏不相加**；正常行无 detail；相对时间取**启用账号**最新（忽略停用号更新） |
| AC-12 行点击 | 通过 | `ipc.ts#summaryOpenAccount{accountId}` → `summary_open_account` → 复用 `tray::open_account_detail` → emit 既有 `tray-open-account`（主界面监听不变）；空 id 返回可读 Err |
| AC-13 Escape | 通过 | `SummaryPopup.tsx` keydown `Escape` → `hide_summary_popup`；窗口失焦同样立即隐藏 |
| AC-14 美观可核 | 通过 | `summary.css` **零硬编码色值**、`var(--)`×21；`.summary-card` 注释即「唯一一层边框 + 唯一一个阴影」，内层显式 `border:none; box-shadow:none`；`tabular-nums`×5；`prefers-reduced-motion`×2 |
| AC-15 无回归 | 通过 | `tsc` 0；`npm test` **362/362**（本机）与 **362/362**（TZ=UTC）；`cargo test` **82**；clippy/fmt 0；基线 276 条断言**删除/改动 = 0** |

## 2. 跨端契约

窗口 `label=summary` ↔ `POPUP_LABEL` 常量 ↔ `capabilities/summary.json#windows` ↔ `tauri.conf.json#url=summary.html` 四处一致；4 个 IPC `show_summary_popup` / `hide_summary_popup` / `set_summary_pointer_inside{inside}` / `summary_open_account{accountId}` 与 `src/summary/ipc.ts` 逐字对应（Rust `account_id` ↔ 前端 `accountId` 为标准 camelCase 映射）；托盘 `Enter/Leave/Move` → `on_tray_*`（经 `phys_rect_from_tauri`），**左键仍走 `on_tray_left_click`（R17 切换不变）**。

## 3. 多页构建

`dist/summary.html` 与 `dist/index.html` 均产出；**summary 入口 5,332 B（recharts 命中 0）**；主入口 `main-CaQUsWEF.js` 131,397 B（命中 0），另有共享 chunk `styles-*.js` 148,670 B → **主 + 共享 ≈279 KB，与 R17 的 283.7 KB 持平**（与 Lead 的「≈280KB」一致）；recharts 仍在懒加载 chunk（`generateCategoricalChart` 343 KB 等），主图能力未丢。

## 4. 冻结哈希（sha256 前 16；PRE==POST）

`summary.rs d099bf5694d02473`｜`tray.rs c45d335430485719`｜`lib.rs 7706c435089cf2b1`｜`commands.rs 0c37ab4c8582849c`｜`tauri.conf.json 63b32d017924b41b`｜`capabilities/summary.json bc6bccb2fcc607b7`｜`capabilities/default.json 7d54937de7c55485`｜`SummaryPopup.tsx 45ef6b4073481a31`｜`SummaryCard.tsx ce18200b8fdcb22d`｜`ipc.ts 18730535512971cc`｜`main.tsx bc20460f011b5afe`｜`summary.css c19936e5fb5dcc71`｜`summaryData.ts 1652d73ef591405d`｜`balances.ts 9c09f34b0cc6a1df`｜`vite.config.ts 1be47fabc7cb6a2a`｜`summary.html 33b35519a7541343`｜`styles.css 5d0bfd8f3ce0d98e`｜`App.tsx 86ebc2719c0b32f6`。

## 5. 越界与裁决

写者 = fe-k3（`src/**`、`vite.config.ts`、`summary.html`）、开发 B（`src-tauri/**`）、PM（`docs/`），外加 **Lead 对 `tauri.conf.json` 删除 `backgroundColor`（授权集成改动）** → **无越界**。该裁决**采纳且正确**：Windows 忽略 alpha 会让浮层失去透明与圆角，删字段保证 Windows 观感（用户本轮主诉求）；代价是 macOS 浮层背景兜底缺失，记为**已知限制**。

## 6. 观察项（不阻断）

- **O-1**：Tauri 2 无 no-activate，`focus:false` 仍可能抢焦点 → 已按规格由「blur 立即隐藏」兜底；手测 M-2 时留意主窗口是否被夺焦。
- **O-2**：`phys_rect_from_tauri` 对逻辑变体按 scale=1 兜底（Windows/macOS 托盘几何本就是物理，不受影响）。
- **O-3**（透明记录）：我探针有两处**自身期望值笔误**（48h 前的日期按本地时区应为 `2026-10-14`；测试错误串恰好 24 字符故不截断），实现均正确；截断逻辑另用 30 字符样例独立验证（输出 25 字含「…」）。

## 7. 结论与真机手测清单

**建议推送**。AC-1..AC-15 全部有独立复算证据；唯一不通过面是 M-1..M-6（**需真机手测**）。
**手测步骤（约 1 分钟）**：① Windows 设置 → 个性化 → 任务栏 → 「其他系统托盘图标」，把本应用**设为常显**（避免折叠进溢出区）；② 回桌面**悬停**该图标（不点击）→ 约 0.15 秒出现「用量总结」浮层、位于图标旁且**不压光标**；③ 指针移入浮层停留 3 秒 → 不消失；移出 → 约 0.25 秒消失；④ 再悬停后按 **Escape** → 立即消失；⑤ **左键**点图标 → 主窗口显示/隐藏切换且浮层不残留；**右键** → 原生菜单正常；⑥ 若任务栏不在底部或接了第二屏，重复②确认贴边与不越屏。
