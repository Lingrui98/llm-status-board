// R16 常驻与自动化：Settings → 运行参数的解析（纯函数，测试友好）。
//
// 放在这里的理由：App.tsx 需要这些解析结果，而 SettingsView 又 import App 层的类型；
// 单独成模块可避免 App ↔ SettingsView 的循环导入（也让纯函数便于单测）。
//
// 默认值严格照 docs/round-16-plan.md §1：
//   systemNotifications → false（默认关，不对用户突然弹通知）
//   refreshRetryEnabled → true
//   refreshRetryMax     → 1（合法 0–3 整数）

import type { Settings } from "./types";

/** 自动重试配置（旧配置缺字段 → 规格默认：启用 + 1 次） */
export function resolveRetrySettings(settings?: Settings | null): { enabled: boolean; max: number } {
  const raw = settings?.refreshRetryMax;
  const max = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 3 ? Math.trunc(raw) : 1;
  return { enabled: settings?.refreshRetryEnabled ?? true, max };
}

/** 系统通知开关（缺省 false） */
export function isSystemNotifyEnabled(settings?: Settings | null): boolean {
  return settings?.systemNotifications ?? false;
}

/** 关闭窗口到托盘（缺省 true，与 Rust Option<bool> 对齐） */
export function isCloseToTrayEnabled(settings?: Settings | null): boolean {
  return settings?.closeToTray ?? true;
}

/** R23：限额窗口明细显示方式（缺省 percent；非 "raw" 一律回落 percent，与 Rust `quota_detail_mode` 一致） */
export function resolveQuotaDetailDisplay(settings?: Settings | null): "percent" | "raw" {
  return settings?.quotaDetailDisplay === "raw" ? "raw" : "percent";
}
