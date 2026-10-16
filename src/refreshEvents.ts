// R21 刷新生命周期事件（前端 → Rust）。
//
// 背景：托盘菜单「立即刷新」与主面板刷新统一走前端 `refresh()` 单一路径
// （Rust 只 emit `tray-refresh`，由 App 调用同一个 refresh）。因此 Rust 需要知道
// 「这一轮刷新结束了」，才能把菜单项从「刷新中…」恢复为可点击，并重建账号区。
//
// 契约：`refresh()` 的 finally（成功与失败都）emit `frontend-refresh-settled`。
// 无事件后端（jsdom 单测 / 权限受限）时静默降级，绝不影响刷新主流程。

import { emit } from "@tauri-apps/api/event";

/** 刷新结束事件名（前端 → Rust；与 Rust 侧 listen_global 的名称必须一致） */
export const FRONTEND_REFRESH_SETTLED = "frontend-refresh-settled";

/** 通知 Rust「本轮刷新已结束」（成功/失败都发；失败静默，不抛） */
export function emitRefreshSettled(): void {
  try {
    void Promise.resolve(emit(FRONTEND_REFRESH_SETTLED)).catch(() => {});
  } catch {
    // 无事件后端：忽略
  }
}
