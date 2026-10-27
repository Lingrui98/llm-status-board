import { isCnyCurrency, normalizeCurrency } from "./insights";
import type { AccountInfo } from "./types";
import { normalizeLocalDay } from "./localDay";

/** 将站点常见的货币符号和代码归一到看板使用的币种代码。 */
export function dashboardCurrency(value?: string | null): string {
  const raw = (value ?? "").trim();
  if (raw === "$" || raw.toUpperCase() === "US$") return "USD";
  if (raw === "¥" || raw === "￥" || isCnyCurrency(raw)) return "CNY";
  return normalizeCurrency(raw);
}

/**
 * 汇总一个账号在指定本地日历日的费用。
 * 同一费用单位先合并，调用方不得跨币种相加。
 */
export function accountCostsForDate(info: AccountInfo | null | undefined, dateKey: string): Record<string, number> {
  const result: Record<string, number> = {};
  if (!info || !dateKey) return result;
  for (const point of info.dailyUsage ?? []) {
    if (!point.date || normalizeLocalDay(point.date) !== dateKey) continue;
    if (typeof point.cost !== "number" || !Number.isFinite(point.cost)) continue;
    const currency = dashboardCurrency(point.costUnit || info.balance?.currency);
    result[currency] = (result[currency] ?? 0) + point.cost;
  }
  return result;
}

/** 卡片只展示一个费用单位：优先主余额币种，否则取首个实际返回的单位。 */
export function accountCostForDate(
  info: AccountInfo | null | undefined,
  dateKey: string,
): { amount: number; currency: string } | null {
  const costs = accountCostsForDate(info, dateKey);
  const preferred = dashboardCurrency(info?.balance?.currency);
  if (Object.prototype.hasOwnProperty.call(costs, preferred)) {
    return { amount: costs[preferred], currency: preferred };
  }
  const currency = Object.keys(costs)[0];
  return currency ? { amount: costs[currency], currency } : null;
}
