// R19 详情抽屉「维度级空数据判定」（规格 §3）：各维度独立判断，互不继承。
// 判定规则按规格 §3 原文（比图表自身的渲染门槛更宽）：
//   daily   ：dailyUsage 中存在 ≥1 个有效点（requests/tokens/inputTokens/outputTokens/cost 任一非 null）
//   model   ：modelUsage 中存在 ≥1 个有效点（同上）
//   token   ：modelUsage 中存在 ≥1 个点的 token 字段非 null
//   balance ：该账号快照数 ≥ 2（1 个快照成不了趋势）
//   total   ：该账号含有效总额度的快照数 ≥ 2，旧余额记录不计入
//   breakdown（扩展）：额度构成有可画数据（总额度 > 0 且(已用或余额可得)，或有有效配额窗口）
//                       —— 规格 §3 只列了前四维；额度构成的空态同样是「无数据项」，
//                       这里按同一语义一并折叠（纯扩展，不改任何数据口径）。

import { validQuotaWindows } from "./primaryMetric";
import type { AccountInfo, BalanceSnapshot, UsagePoint } from "./types";

function hasAnyMetricPoint(points?: readonly UsagePoint[] | null): boolean {
  if (!points || points.length === 0) return false;
  return points.some(
    (p) =>
      !!p &&
      ((p.requests ?? null) !== null ||
        (p.tokens ?? null) !== null ||
        (p.inputTokens ?? null) !== null ||
        (p.outputTokens ?? null) !== null ||
        (p.cost ?? null) !== null),
  );
}

/** daily：dailyUsage 里有 ≥1 个有效点 */
export function hasDailyUsageData(points?: readonly UsagePoint[] | null): boolean {
  return hasAnyMetricPoint(points);
}

/** model：modelUsage 里有 ≥1 个有效点 */
export function hasModelUsageData(points?: readonly UsagePoint[] | null): boolean {
  return hasAnyMetricPoint(points);
}

/** token：modelUsage 里有 ≥1 个点带 token 字段（tokens / inputTokens / outputTokens） */
export function hasTokenSplitData(points?: readonly UsagePoint[] | null): boolean {
  if (!points || points.length === 0) return false;
  return points.some(
    (p) => !!p && ((p.tokens ?? null) !== null || (p.inputTokens ?? null) !== null || (p.outputTokens ?? null) !== null),
  );
}

/** balance：该账号余额快照数 ≥ 2 */
export function hasBalanceTrendData(snapshots: readonly BalanceSnapshot[], accountId: string): boolean {
  let count = 0;
  for (const s of snapshots) {
    if (s && s.accountId === accountId) count += 1;
  }
  return count >= 2;
}

/** 该账号余额快照条数（供 1 条时的专属折叠说明用，规格 §3） */
export function balanceSnapshotCount(snapshots: readonly BalanceSnapshot[], accountId: string): number {
  let count = 0;
  for (const s of snapshots) {
    if (s && s.accountId === accountId) count += 1;
  }
  return count;
}

/** 只统计实际记录过总额度的快照，0 也有效。 */
export function totalSnapshotCount(snapshots: readonly BalanceSnapshot[], accountId: string): number {
  return snapshots.filter((s) => s.accountId === accountId && typeof s.total === "number" && Number.isFinite(s.total)).length;
}

/** breakdown（扩展）：额度构成是否有可画数据 */
export function hasBreakdownData(info?: AccountInfo | null): boolean {
  if (!info) return false;
  const totalAmt = info.total?.amount;
  const hasAmountComposition =
    totalAmt !== null && totalAmt !== undefined && totalAmt > 0 && (info.used != null || info.balance != null);
  return hasAmountComposition || validQuotaWindows(info.quotaWindows).length > 0;
}

export interface DrawerDataFlags {
  breakdown: boolean;
  daily: boolean;
  model: boolean;
  token: boolean;
  balance: boolean;
  total: boolean;
}

/** 一次算出各维度的 hasData（判定互相独立） */
export function drawerDataFlags(
  info: AccountInfo | null | undefined,
  snapshots: readonly BalanceSnapshot[],
  accountId: string,
): DrawerDataFlags {
  return {
    breakdown: hasBreakdownData(info),
    daily: hasDailyUsageData(info?.dailyUsage),
    model: hasModelUsageData(info?.modelUsage),
    token: hasTokenSplitData(info?.modelUsage),
    balance: hasBalanceTrendData(snapshots, accountId),
    total: totalSnapshotCount(snapshots, accountId) >= 2,
  };
}
