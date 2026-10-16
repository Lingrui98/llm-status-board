// 托盘悬停「用量总结」浮层的 IPC 适配层（R18）。
// 契约（dev-backend / task-35，参数名经 Tauri camelCase 映射）：
// - hide_summary_popup            ：无参，立即隐藏（Escape / 失焦 / 左键 / 行点击）
// - show_summary_popup            ：无参，手动显示（悬停之外的兜底入口，本浮层不主动调用）
// - set_summary_pointer_inside    ：{ inside: boolean }，进入/离开浮层时取消或重建待隐藏定时器
// - summary_open_account          ：{ accountId: string }，显示并聚焦主窗口 + 切到该账号详情
//   后端内部 emit 既有事件 tray-open-account，主界面 App.tsx 现有监听即可复用 focusRequest。
//
// 全部返回 Result<(), String>：这里不吞错，调用方按「非阻塞」处理（失败只影响本浮层交互）。

import { invoke } from "@tauri-apps/api/core";

/** 立即隐藏浮层（延迟 0） */
export async function hideSummaryPopup(): Promise<void> {
  await invoke("hide_summary_popup");
}

/** 手动显示浮层（兜底入口；常规显示由 Rust 悬停状态机驱动） */
export async function showSummaryPopup(): Promise<void> {
  await invoke("show_summary_popup");
}

/** 指针进入/离开浮层：true = 指针在浮层内（取消待隐藏） */
export async function setSummaryPointerInside(inside: boolean): Promise<void> {
  await invoke("set_summary_pointer_inside", { inside });
}

/** 点击账号行：显示+聚焦主窗口并切到该账号详情 */
export async function summaryOpenAccount(accountId: string): Promise<void> {
  await invoke("summary_open_account", { accountId });
}
