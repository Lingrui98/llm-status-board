// 托盘悬停「用量总结」浮层的纯视图模型（R18）。
// 只做「取现有数据 → 展示口径」的纯计算，便于注水单测；数据源仍是既有结果与本地历史，
// 不新增数据源、不改任何数据口径（余额合计复用 src/balances.ts，与主窗口总览条同源）。

import { aggregateBalances } from "../balances";
import { formatMoneyParts } from "../format";
import {
  NO_DATA_TEXT,
  formatFailureLine,
  formatPrimaryMetricLine,
  pickPrimaryMetric,
  validQuotaWindows,
  type QuotaDetailDisplay,
} from "../primaryMetric";
import type { AccountConfig, Money, QuotaWindow, RefreshOutcome, UsageRecord } from "../types";

/** 行状态：正常 / 异常 / 未刷新（后端确认本轮只渲染启用账号，含「停用」状态） */
export type SummaryRowStatus = "ok" | "err" | "idle";

export interface SummaryRow {
  accountId: string;
  name: string;
  /** 单行规范串（R20 §1，与托盘逐字一致）：失败 `✗ 原因` / 订阅 `剩余 X%（窗口）` / 余额 `金额 币种` / 无数据 `—` */
  valueText: string;
  status: SummaryRowStatus;
  /** R23：该账号全部有效配额窗口（usedPercent 为有限数字者），用于明细条；无窗口 → 空数组 */
  windows: (QuotaWindow & { usedPercent: number })[];
}

export interface SummaryData {
  /** 启用（监控）账号数 = 行数 */
  total: number;
  okCount: number;
  failCount: number;
  idleCount: number;
  /** USD / CNY 分栏合计（已格式化，绝不跨币种相加） */
  usdText: string;
  cnyText: string;
  rows: SummaryRow[];
  /** 最后刷新的相对时间文案（§4 阶梯） */
  lastRefreshText: string;
  /** 本地用量历史天数（日期去重） */
  historyDays: number;
  /** R23：限额窗口明细显示方式（百分比条 / 原始数字；缺省 percent） */
  quotaDisplay: QuotaDetailDisplay;
}

/** 异常原因截断长度（规格 §4：截断 24 字符） */
export const REASON_MAX_CHARS = 24;

/** 超长文本截断（保留语义，末尾单字符省略号） */
export function truncateText(text: string, max: number = REASON_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** 余额文本：USD→$、CNY→¥，其余币种退化为「数值 代码」；无余额 → null */
export function balanceText(money?: Money | null): string | null {
  const parts = formatMoneyParts(money);
  if (!parts) return null;
  if (parts.currency === "USD") return `$${parts.num}`;
  if (parts.currency === "CNY") return `¥${parts.num}`;
  return `${parts.num} ${parts.currency}`;
}

/** 最紧（用量最高）的配额窗口百分比，clamp 到 0–100；无有效窗口 → null */
export function tightestQuotaPercent(windows?: readonly QuotaWindow[] | null): number | null {
  if (!windows || windows.length === 0) return null;
  let worst: number | null = null;
  for (const w of windows) {
    if (!w || typeof w.usedPercent !== "number" || Number.isNaN(w.usedPercent)) continue;
    const pct = Math.min(100, Math.max(0, w.usedPercent));
    if (worst === null || pct > worst) worst = pct;
  }
  return worst;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 最后刷新相对时间（规格 §4）：
 * <1min「刚刚」→ <60min「N 分钟前」→ <48h「N 小时前」→ 否则本地日期。
 */
export function formatLastRefresh(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 172_800_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地历史天数：usage-history 记录里不同本地日历日（date）的去重计数 */
export function countHistoryDays(records: readonly UsageRecord[]): number {
  const days = new Set<string>();
  for (const r of records) {
    if (r && typeof r.date === "string" && r.date) days.add(r.date);
  }
  return days.size;
}

/**
 * 浮层账号行的单行规范串（R20 §2 唯一出口，与托盘共用同一套语义）：
 * 1. 失败（结果层，优先级最高）→ `✗ {原因}`（12 字符截断）；
 * 2. 否则复用 `pickPrimaryMetric` → 订阅 `剩余 X%（窗口）` / 余额 `金额 币种`；
 * 3. 无结果（未刷新）或 info 为 null → `—`。
 * **禁止**在本文件另写一份判定逻辑（判定顺序唯一在 src/primaryMetric.ts）。
 */
export function summaryRowText(outcome?: RefreshOutcome | null): string {
  if (!outcome) return NO_DATA_TEXT;
  if (!outcome.ok) return formatFailureLine(outcome.error);
  return formatPrimaryMetricLine(pickPrimaryMetric(outcome.info));
}

/**
 * 组装浮层视图模型。
 * - 行 = 启用账号（AC-11）；禁用账号不出行；
 * - 合计只统计这些启用账号的刷新结果（与「监控账号数」同口径）；
 * - 最后刷新时间取这些结果里最新的 fetchedAt。
 * - R23：行携带全部有效配额窗口（明细条数据）；quotaDisplay 缺省 percent。
 */
export function buildSummary(input: {
  accounts: readonly AccountConfig[];
  outcomes: readonly RefreshOutcome[];
  historyRecords: readonly UsageRecord[];
  now?: number;
  /** R23：限额窗口明细显示方式（缺省 percent） */
  quotaDisplay?: QuotaDetailDisplay;
}): SummaryData {
  const { accounts, outcomes, historyRecords } = input;
  const now = input.now ?? Date.now();

  const enabled = accounts.filter((a) => a.enabled);
  const enabledIds = new Set(enabled.map((a) => a.id));
  const byId = new Map<string, RefreshOutcome>();
  for (const o of outcomes) {
    if (o && enabledIds.has(o.accountId)) byId.set(o.accountId, o);
  }

  let okCount = 0;
  let failCount = 0;
  let idleCount = 0;
  let latest = 0;
  let latestIso: string | null = null;

  const rows: SummaryRow[] = enabled.map((acc) => {
    const o = byId.get(acc.id);
    let status: SummaryRowStatus;
    if (!o) {
      status = "idle";
      idleCount += 1;
    } else if (o.ok) {
      status = "ok";
      okCount += 1;
    } else {
      status = "err";
      failCount += 1;
    }

    // R20：行文本统一走规范串出口（失败 → 订阅/余额 → 无数据），不再用「余额优先 + 已用百分比」
    const valueText = summaryRowText(o);

    // R23：透传全部有效窗口（明细条用；判定与过滤的唯一事实来源仍是 primaryMetric）
    const windows = o?.ok && o.info ? validQuotaWindows(o.info.quotaWindows) : [];

    const fetched = o?.info?.fetchedAt;
    if (fetched) {
      const t = new Date(fetched).getTime();
      if (!Number.isNaN(t) && t > latest) {
        latest = t;
        latestIso = fetched;
      }
    }

    return { accountId: acc.id, name: acc.name, valueText, status, windows };
  });

  const totals = aggregateBalances(byId.values());

  return {
    total: enabled.length,
    okCount,
    failCount,
    idleCount,
    usdText: `$${totals.usd.toFixed(2)}`,
    cnyText: `¥${totals.cny.toFixed(2)}`,
    rows,
    lastRefreshText: formatLastRefresh(latestIso, now),
    historyDays: countHistoryDays(historyRecords),
    quotaDisplay: input.quotaDisplay ?? "percent",
  };
}
