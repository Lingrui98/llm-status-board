// R16 插件运行时接线：把纯逻辑模块（autostart.ts / systemNotifyApi.ts）接到真实 Tauri 插件上。
//
// 为什么用动态 import：
// - 插件包只在 Tauri WebView 里有真实后端，jsdom / 浏览器预览下 import 本身不报错但调用会失败；
// - 动态 import + try/catch 让任何加载/权限/平台问题都降级为「可读错误」，绝不让应用白屏
//   （规格 §0：任何插件失败都不得让应用不可用）。
// - 测试通过 vi.mock 替换本模块，不依赖真实插件。

import type { AutostartApi } from "./autostart";
import type { SystemNotifyApi } from "./systemNotifyApi";
import type { UpdaterApi } from "./updater";
import { releasePageUrl } from "./updater";
import type { Update } from "@tauri-apps/plugin-updater";

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

/* ---------- R22 一键更新（docs/round-22-updater-plan.md §4.1） ---------- */

/**
 * 上一次 check 发现的待安装更新句柄（插件 Update 对象持有 Rust 侧资源）。
 * check 与 downloadAndInstall 分两次调用，句柄必须在此暂存；
 * 再次检查 / 安装结束（成败都算）时释放，避免资源泄漏。
 */
let pendingUpdate: Update | null = null;

async function releasePendingUpdate(handle: Update | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // 句柄已被插件释放 / 进程正在退出（Windows 安装器接管）→ 静默
  }
}

/** Rust check_channel_update 返回的插件 Update 构造参数。 */
interface ChannelUpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string | null;
  body?: string | null;
  rawJson: Record<string, unknown>;
}

/** 真实更新 API：Rust 选择渠道端点，官方 JS Update 继续负责下载、签名校验和安装。 */
export const pluginUpdater: UpdaterApi = {
  async check(proxy, channel) {
    const [mod, core] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/api/core"),
    ]);
    // 切换渠道或再次检查时，先释放旧渠道的待安装句柄。
    await releasePendingUpdate(pendingUpdate);
    pendingUpdate = null;
    const metadata = await core.invoke<ChannelUpdateMetadata | null>("check_channel_update", {
      channel,
      proxy: proxy?.trim() || null,
      timeout: 15_000,
    });
    if (!metadata) return null;
    const update = new mod.Update({
      ...metadata,
      date: metadata.date ?? undefined,
      body: metadata.body ?? undefined,
    });
    pendingUpdate = update;
    return { version: update.version, notes: update.body ?? "", date: update.date ?? "" };
  },

  async downloadAndInstall(onProgress) {
    if (!pendingUpdate) throw new Error("没有待安装的更新，请先检查更新");
    const update = pendingUpdate;
    let received = 0;
    let total: number | null = null;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          onProgress(0, total);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          onProgress(received, total);
        }
        // Finished：安装由插件继续完成，无需在此处理
      });
    } finally {
      // Windows 上安装器接管后进程直接退出，这里可能执行不到——属预期，不依赖它做任何事
      await releasePendingUpdate(update);
      if (pendingUpdate === update) pendingUpdate = null;
    }
  },

  async relaunch() {
    const mod = await import("@tauri-apps/plugin-process");
    await mod.relaunch();
  },

  async openReleasePage(channel) {
    const mod = await import("@tauri-apps/plugin-opener");
    await mod.openUrl(releasePageUrl(channel));
  },
};

/**
 * 运行时应用版本（唯一事实来源：tauri.conf.json 的 version）。
 * 非 Tauri 环境（jsdom / 浏览器预览）返回 null，调用方用打包期常量回退。
 */
export async function queryAppVersion(): Promise<string | null> {
  try {
    const mod = await import("@tauri-apps/api/app");
    const v = await mod.getVersion();
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}
