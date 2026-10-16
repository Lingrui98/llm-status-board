# R17 终审 + 复验冻结（对照 `docs/round-17-plan.md` AC-1..AC-13）

授权判据：本轮 **fe-k3 拥有 `src/**`（含 `styles.css` 与 `components/ui/**`）**，`designer` 未参与、未写文件；开发 B `src-tauri/**`；PM `docs/`。据此复核**无越界**。
方法：结构级独立复算 + 仓库用例实跑 + 门禁哈希夹逼。**坦白一处限制**：我尝试的 SSR/JSDOM 独立渲染探针在 Node 下遇到重复 React 实例（`Invalid hook call`）无法运行，故 AC-1/AC-5/AC-6 的 DOM 行为证据来自「源码结构核对 + 仓库新增 DOM 用例（门禁中实跑）」两条，而非我自己的渲染探针。

## 1. 门禁（PRE==POST，期间无写入）

`npx tsc --noEmit` 0｜`npm test` **335/335**（本机）｜`TZ=UTC npm test` **335/335**｜`cargo test` **70 passed / 0 failed / 7 ignored**｜`cargo clippy -D warnings` / `cargo fmt --check` 均 0｜`npx vite build` 成功，入口 `index-D_aHsG4a.js`（290 KB）`recharts-` 命中 **0**。

## 2. AC 判定

| AC | 判定 | 证据 |
|---|---|---|
| AC-1 行序 | 通过（结构级 + 仓库用例） | `Dashboard.tsx` 主分支同父级 JSX 顺序实测：summary-bar(6118) → global-stats(8043) → card-grid(9785) → 洞察(10428) → 分析(10699)，全部落在同一 `<main>` 区间内；JSX 兄弟顺序即 DOM 顺序 |
| AC-2 默认收起 | 通过 | `useSectionOpen.ts:40` 初值 `readStored()[section] === true`（无记录/损坏/不可用 → `{}` → `false`）；`:16-33` 读取全程 try/catch；`:42-56` **只有 toggle 内写盘**（`localStorage.setItem` 全文件 1 处，初始读取不写） |
| AC-3/4 单项记忆 | 通过 | `stored[section] = next` 按 block 分键写回（保留另一区块的值）→ 展开其一不影响其二；仓库用例断言 `stored` 分别 `{insights:true}` / `{analysis:true}` |
| AC-5 摘要同源 | 通过（同类 R16 的"最容易撒谎"项） | 分析：摘要 `periodAmountText(c.costThis, c.currency)`（`:87`）与展开 `value={formatDecimal(c.costThis)}`（`:208`）**同一字段**，且 `periodAmountText` = `"$" + formatDecimal(amount)`（`:70-75`）→ 数字逐字一致；洞察：摘要与展开 StatTile 共用 `fastestSummaryText` / `formatBurnRate` / `formatDaysLeft`。仓库用例以**同一字面串**双向断言：`"消耗最快：15.00 USD/天，余额约可支撑 4.7 天"` 同时出现在收起摘要与展开正文 |
| AC-6 折叠 a11y | 通过 | 两面板 `aria-expanded={open}` + `aria-controls`/`id` 成对（`insights-panel-body` / `analysis-panel-body`），头部为真实 `<button>`（Enter/Space 原生可切换）；内容在 `{open && (` 内条件渲染 → **收起时不在 DOM ⇒ 不进 Tab 序** |
| AC-7/8/9 托盘左键 | **通过（纯函数级）；真机面无法验证（真机）** | `should_hide_on_tray_click = is_visible && !is_minimized`；左键分支调用 `toggle_main_window`（`tray.rs`，Win/macOS 同逻辑）；读取失败 `is_some_and(...)` → `false` → **回落为显示+聚焦**（不会误隐藏）；仓库 4 组分支用例在门禁中全绿。**实际窗口隐藏/还原因本机 WebView2 实例占用无法冒烟** |
| AC-10 菜单不回归 | 通过 | `MENU_SHOW => show_main_window(app)` 原样保留（只显示不切换） |
| AC-11 观感可核项 | 通过（仅判可核条款） | 三处头部同用 `global-stats-head`；两面板均含 `StatTile`（首屏大字号数字）；5 个图表 `CartesianGrid` 全部 `vertical={false}`（仅水平网格）；R17 块 3 处 `border-top: 1px` 为**同一容器内的分隔线**（单元素 ≤1 层），`box-shadow` 声明**全部为 `none`**（去卡片化） |
| AC-12 明暗/动效/对比度 | 通过（抽样计算） | R17 新增 126 行**零硬编码色值**（0 处 hex/rgba）；正文与强调数字对比度抽样：暗色 **16.49 / 7.41**、亮色 **15.15 / 4.54**，均 ≥4.5:1；`prefers-reduced-motion` 与 `:focus-visible` 规则存在 |
| AC-13 无回归 | 通过 | 见 §1；另核 13 个既有测试文件对照 HEAD：**删除/改动 4 行，且全部是 R17 要求的「默认收起」断言翻转与标题/占位文案更名**（`aria-expanded` true→false、"深度分析"→"用量花费分析"、占位文案），**零数据口径断言改动**（新摘要用例的 70 vs 50 → +40% 与既有 AC-10 口径一致） |

## 3. 冻结哈希（sha256 前 16；PRE==POST）

`Dashboard.tsx 7d211923fd0ae250`｜`InsightsPanel.tsx edf9b5dcaab2eea9`｜`AnalysisView.tsx 2fc3f9ced98d93dd`｜`useSectionOpen.ts 94591f939f899714`｜`InsightsPanel.test.tsx b8d38c0264781732`｜`AnalysisView.test.tsx c00e7d521bf1d7e5`｜`styles.css 5d0bfd8f3ce0d98e`｜`App.tsx 86ebc2719c0b32f6`｜`App.test.tsx 6196b5f75b519c93`｜`ui/SettingRow.tsx 9c1e6b52c146d723`｜`src-tauri/src/tray.rs ba0fb003058b79d6`。

## 4. 观察项（不阻断，非口味判断）

- **O-1（工具限制）**：我的独立渲染探针因 Node SSR 下重复 React 无法执行；如需独立的 DOM 级证据，正确载体是仓库 vitest（需在 `src/**` 放测试文件，超出 PM 写权限）。AC-1/5/6 因此为「结构核对 + 仓库 DOM 用例」双证，已如上标注。
- **O-2（次要）**：`useSectionOpen.ts:43-55` 在 `setOpen` 的更新函数内写 localStorage（与我在 R16 报的 D-2 同一模式）。StrictMode 下更新函数可能执行两次 → `setItem` 重复但同值幂等，无实际危害；若要彻底对齐 R16 修法，可把写盘移到 `useEffect([open])` 并用首次挂载守卫。
- **O-3（设计确认，非缺陷）**：洞察摘要取「最紧急/最紧」账号（`report.fastest` 优先，其次 daysLeft 最小），展开态按账号逐条列出 —— 摘要数字必然等于其中某一行，不存在撒谎面。

## 5. 结论

**建议推送**。AC-1..AC-6、AC-10..AC-13 有独立证据（结构复算 + 门禁 + 抽样计算）；AC-7/8/9 的**纯函数与降级路径**通过，**真机窗口隐藏/还原**如实标为「无法验证（真机）」，需打包后手工点一次托盘左键确认（不影响推送）。
