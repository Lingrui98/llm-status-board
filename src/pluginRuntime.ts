// R16 插件运行时接线：把纯逻辑模块（autostart.ts / systemNotifyApi.ts）接到真实 Tauri 插件上。
//
// 为什么用动态 import：
// - 插件包只在 Tauri WebView 里有真实后端，jsdom / 浏览器预览下 import 本身不报错但调用会失败；
// - 动态 import + try/catch 让任何加载/权限/平台问题都降级为「可读错误」，绝不让应用白屏
//   （规格 §0：任何插件失败都不得让应用不可用）。
// - 测试通过 vi.mock 替换本模块，不依赖真实插件。

import type { AutostartApi } from "./autostart";
import type { SystemNotifyApi } from "./systemNotifyApi";

/** 真实自启 API（§2）：enable / disable / isEnabled */
export const pluginAutostart: AutostartApi = {
  async isEnabled() {
    const mod = await import("@tauri-apps/plugin-autostart");
    return mod.isEnabled();
  },
  async enable() {
    const mod = await import("@tauri-apps/plugin-autostart");
    await mod.enable();
  },
  async disable() {
    const mod = await import("@tauri-apps/plugin-autostart");
    await mod.disable();
  },
};

/** 真实系统通知 API（§4）：isPermissionGranted / requestPermission / sendNotification */
export const pluginSystemNotify: SystemNotifyApi = {
  async isPermissionGranted() {
    const mod = await import("@tauri-apps/plugin-notification");
    return mod.isPermissionGranted();
  },
  async requestPermission() {
    const mod = await import("@tauri-apps/plugin-notification");
    return mod.requestPermission();
  },
  sendNotification(payload: { title: string; body: string }) {
    // 插件是异步加载的，但 sendNotification 本身是同步 API：
    // 这里用 fire-and-forget 的方式调用（失败已在 sendSystemNotify 内被捕获为静默降级）。
    void import("@tauri-apps/plugin-notification")
      .then((mod) => mod.sendNotification(payload))
      .catch(() => {
        // 平台无通知服务 / 插件不可用 → 静默降级为应用内通知，不重试
      });
  },
};

/**
 * 平台判定（§4 权限被拒提示用）—— 纯字符串输入，便于单测；默认读 navigator.userAgent。
 */
export function detectPlatform(userAgent?: string): "windows" | "macos" | "linux" | "other" {
  const ua = (
    userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toLowerCase();
  if (!ua) return "other";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh") || ua.includes("darwin")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "other";
}

/**
 * 系统通知被拒后的**手动放行路径**文案。
 *
 * 为什么需要它：插件只提供 `requestPermission()`，**无法打开系统设置页**
 * （原 `openSystemNotificationSettings` 是防御性 no-op，已删除以免文案与行为不符）。
 * 用户点「重新请求授权」若仍被拒，必须知道去哪里手动放行，否则会卡死。
 */
export function notificationManualPath(platform?: string): string {
  switch (platform ?? detectPlatform()) {
    case "windows":
      return "手动放行：Windows 设置 → 系统 → 通知 → 找到「LLM Status Board」并允许。";
    case "macos":
      return "手动放行：macOS 系统设置 → 通知 → 找到「LLM Status Board」并允许。";
    case "linux":
      return "手动放行：在桌面环境的通知设置里找到「LLM Status Board」并允许。";
    default:
      return "手动放行：在系统设置的「通知」中允许「LLM Status Board」发送通知。";
  }
}

/** 权限被拒提示的按钮文案（如实描述：只重新请求，不打开系统设置） */
export const NOTIFY_PERMISSION_RETRY_LABEL = "重新请求授权";
