# Round 24 计划：浮层尺寸可调 + 菜单去额度化 + 重置时间显示

## 0. 背景与需求

R23 上线后用户反馈：
1. 悬停浮层尺寸固定（300×360），希望**可快捷调整**；
2. 右键菜单**不要额度显示**（R23 的文本条/子菜单移除），只留简洁状态行；
3. bosc（sub2api）「日限额 0 点已重置但显示仍超限」排查结论：站点自然日 0 点重置 + **lazy compute**（当天首次真实请求才触发重算，之前接口返回昨日旧值）——应用如实显示接口值，无转换 bug。用户实测 + 实时接口数据双证。

## 1. 决策

| 需求 | 方案 | 理由 |
|---|---|---|
| 浮层尺寸调整 | 右下角拖拽手柄 → `startResizeDragging("SouthEast")`（原生拖拽），尺寸写 localStorage 记忆（`lsb-summary-size`），启动恢复 | 无边框窗口的常规做法；比「预设档位」更快捷 |
| 尺寸下限 | 260×300（tauri.conf.json minWidth/minHeight + 前端 clamp 双保险），上限 1200 防误拖 | 低于下限布局会挤坏 |
| 定位适配 | `position_window` 改用窗口当前实际尺寸（inner_size → 逻辑），不再用固定常量 | 尺寸变了定位必须跟随，否则压光标/越屏 |
| 菜单去额度化 | 回退 R23 的文本条/子菜单/`account_line_text` 等，账号区回到 R20/R21 纯状态行 | 用户明确要求 |
| 设置开关保留 | `quotaDetailDisplay` 仍作用于浮层明细区（提示文案改为仅浮层） | 开关本身有用，只是作用域收窄 |
| 重置时间 | 7d 窗口用响应自带 `weekly_window_start` +7 天；1d 按本地次日 0 点（用户实测验证的自然日重置）；1m 无锚点不编造 | 让「额度什么时候回来」可见 |

保留项：`rebuild_menu_now`（save_config 钩子）保留——账号增删/改名/排序即时反映到菜单，与额度无关的正当收益。sub2api 数字限额转换保留（主卡/浮层/提醒仍受益）。

## 2. 改动清单

- `tray.rs`：回退 R23 菜单增强（删 quota_bar_text / window_detail_line / account_line_text / QuotaDetailMode / 子菜单构建 / 相关测试）
- `primary_metric.rs`：R23 提为 pub(crate) 的 5 个助手回收为私有
- `tauri.conf.json`：summary 窗口 resizable: true + min 260×300
- `capabilities/summary.json`：+ `core:window:allow-set-size` + `core:window:allow-start-resize-dragging`（core:default 已含事件 listen 与尺寸查询）
- `summary.rs`：position_window 按当前实际尺寸定位
- `src/summary/summarySize.ts`（新）：尺寸持久化纯逻辑（clamp/load/save）
- `SummaryPopup.tsx`：启动恢复尺寸 + onResized 持久化 + 拖拽手柄回调（动态 import 降级）
- `SummaryCard.tsx`：右下角拖拽手柄元素
- `summary.css`：手柄样式（斜纹，悬停加深）
- `sub2api.rs`：`subscription_quota_windows_at(now)` 注入时间；weekly_window_start +7d / 1d 次日 0 点 / 1m 无
- `SettingsView.tsx`：开关提示文案改为仅浮层
- 测试：tray R23 用例移除；sub2api 重置时间用例新增；summarySize.test.ts 新增（6 条）
- README 第 8 条同步

## 3. 验证

- 前端 489 全绿 + tsc/vite 构建通过；Rust fmt/clippy/单测由 CI 执行。
- 版本 0.2.6 → 0.2.7。
