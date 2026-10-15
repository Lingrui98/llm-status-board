// R16 §4 系统通知：发送薄封装（可注入，便于测试；调用方负责防打扰判定）。
//
// 权限边界（docs/round-16-plan.md §4）：
// - `isPermissionGranted()` 为 false 时，**仅在用户开启开关时**请求一次权限；
// - 用户拒绝后不再重复请求（由调用方保证只在「关→开」时尝试）；
// - 发送失败 / 平台无通知服务 → 捕获并静默降级，**不重试、不弹错**、不影响刷新主流程。

export interface SystemNotifyApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<"granted" | "denied" | "prompt" | string>;
  sendNotification(payload: { title: string; body: string }): void;
}

export type SystemNotifyPermission = "granted" | "denied" | "unknown";

export interface SendSystemNotifyResult {
  /** 是否真的调用了 sendNotification */
  sent: boolean;
  /** 发送后的权限状态 */
  permission: SystemNotifyPermission;
  /** 未发送原因（便于测试与调试） */
  skipped?: "notGranted";
}

/**
 * 发送一条系统通知。
 * @param api 插件薄封装（App 层注入真实实现，测试注入 mock）
 * @param allowRequest true 表示这次可以请求权限（只在用户刚打开开关时传 true）
 */
export async function sendSystemNotify(
  api: SystemNotifyApi,
  payload: { title: string; body: string },
  allowRequest: boolean,
): Promise<SendSystemNotifyResult> {
  let granted = false;
  try {
    granted = await api.isPermissionGranted();
  } catch {
    // 查询权限失败：视作未授权，静默降级（不抛错、不影响主流程）
    return { sent: false, permission: "unknown", skipped: "notGranted" };
  }

  if (!granted && allowRequest) {
    try {
      const res = await api.requestPermission();
      granted = res === "granted";
      if (!granted) return { sent: false, permission: "denied", skipped: "notGranted" };
    } catch {
      return { sent: false, permission: "denied", skipped: "notGranted" };
    }
  }
  if (!granted) return { sent: false, permission: "denied", skipped: "notGranted" };

  try {
    api.sendNotification({ title: payload.title, body: payload.body });
    return { sent: true, permission: "granted" };
  } catch {
    // 平台无通知服务（如 Linux 无守护）→ 静默降级为应用内通知
    return { sent: false, permission: "granted" };
  }
}

/** 只查询权限状态（打开设置页时用，**不**请求权限） */
export async function querySystemNotifyPermission(api: SystemNotifyApi): Promise<SystemNotifyPermission> {
  try {
    return (await api.isPermissionGranted()) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}
