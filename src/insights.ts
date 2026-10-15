// R14 数据洞察：纯函数模块，输入余额历史快照 + 当前刷新结果，输出可展示的洞察指标。
// 口径完全遵循 docs/round-14-plan.md §1；本文件不依赖 React / DOM / Tauri，便于单测。
// 关键原则：任何输入都不得产生 NaN / Infinity；无法计算时返回 null，由 UI 显示「—」。

import type { BalanceSnapshot, RefreshOutcome, Settings } from "./types";

/** 洞察统计窗口默认天数（设置里可配，缺省 14） */
export const DEFAULT_INSIGHT_WINDOW_DAYS = 14;

/** 窗口天数合法区间（与设置面板校验一致） */
export const INSIGHT_WINDOW_MIN_DAYS = 3;
export const INSIGHT_WINDOW_MAX_DAYS = 90;

/** 快照跨度不足该天数（12 小时）时放弃 burn rate —— 跨度过小会让日均消耗被极端放大 */
const MIN_WINDOW_SPAN_DAYS = 0.5;

const DAY_MS = 86_400_000;

/** 额度/点数类单位不是法币，消耗洞察对它们无意义（Kimi 订阅按 credits 计） */
const SKIP_CURRENCIES = new Set(["CREDITS", "CREDIT"]);

/**
 * 点数/订阅类币种集合的只读视图：insights / notifications / reportCsv 三处共用同一份定义，
 * 避免各写一份字面量导致口径漂移（R14 终审 D-1 要求）。
 */
export const SKIPPED_CURRENCIES: ReadonlySet<string> = SKIP_CURRENCIES;

/** 人民币币种的常见写法 */
const CNY_CURRENCIES = new Set(["CNY", "RMB", "CNH"]);

/** 币种归一：去空白 + 大写；空值归为 UNKNOWN（仍参与分组，只是与 USD/CNY 天然隔离） */
export function normalizeCurrency(currency?: string | null): string {
  const c = (currency ?? "").trim().toUpperCase();
  return c === "" ? "UNKNOWN" : c;
}

export function shouldSkipCurrency(currency?: string | null): boolean {
  return SKIP_CURRENCIES.has(normalizeCurrency(currency));
}

export function isCnyCurrency(currency?: string | null): boolean {
  return CNY_CURRENCIES.has(normalizeCurrency(currency));
}

/** 设置 → 洞察窗口天数（非法值回退默认，保证手工改坏的配置不会拖垮洞察） */
export function resolveInsightWindowDays(settings?: Settings | null): number {
  const v = settings?.insightWindowDays;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_INSIGHT_WINDOW_DAYS;
  const n = Math.round(v);
  if (n < INSIGHT_WINDOW_MIN_DAYS || n > INSIGHT_WINDOW_MAX_DAYS) return DEFAULT_INSIGHT_WINDOW_DAYS;
  return n;
}

/** 跳过（不参与洞察）的原因码 */
export type InsightSkipReason = "nonFiat" | "insufficientData" | "noSpend";

export interface InsightSkip {
  accountId: string;
  currency: string;
  reason: InsightSkipReason;
}

/** 单账号单币种的洞察结果（窗口内余额下降速率 + 可支撑天数） */
export interface AccountInsight {
  accountId: string;
  accountName: string;
  currency: string;
  /** 窗口内最新快照余额；窗口内无快照时为 null */
  currentBalance: number | null;
  /** 日均消耗（币种/天）；无法计算时为 null */
  burnRate: number | null;
  /** 可支撑天数 = currentBalance / burnRate；无法计算时为 null */
  daysLeft: number | null;
  /** 窗口内累计下降额（只累计下降段，充值免疫） */
  totalDrop: number;
  /** 窗口内首末快照跨度（天） */
  spanDays: number;
  /** 窗口内快照条数 */
  snapshotCount: number;
  /** 为 null 时的原因：insufficientData（快照不足/跨度过小）| noSpend（无消耗或余额上升） */
  reason: "insufficientData" | "noSpend" | null;
  /** 窗口内按时间升序的余额序列（迷你趋势线数据源） */
  series: number[];
}

export interface UpcomingDaySpend {
  window: string;
  resetsAt?: string | null;
}

/** 本月预计支出（按币种汇总，USD/CNY 不相加） */
export interface MonthProjection {
  currency: string;
  /** 窗口内落在当月的累计下降额 */
  monthDrop: number;
  /** 当月已过天数（今天日期数，1 起） */
  monthDaysElapsed: number;
  /** 当月剩余天数（今天剩余时间不预测，口径偏保守） */
  remainingDays: number;
  /** 预计本月总支出的起点：已发生（monthDrop）+ 按 burnRate 外推的剩余天数 */
  projectedTotal: number;
  /** 其中已发生部分 */
  elapsedSpend: number;
  /** 其中预测部分（账户级 burnRate 合计 × remainingDays） */
  projectedRemaining: number;
  /** 参与汇总的账号数 */
  accountCount: number;
  /** 该币种下所有账号都算不出 burnRate 时为 true（预计支出退化为「仅已发生」） */
  degraded: boolean;
}

export interface FastestAccount {
  accountId: string;
  accountName: string;
  currency: string;
  burnRate: number;
  daysLeft: number | null;
  currentBalance: number | null;
}

/** 风险等级：供 UI 映射 --ok / --warn / --err 语义色（阈值见 docs §1.4） */
export type InsightRisk = "ok" | "warn" | "err";

export interface InsightReport {
  /** 窗口天数（用于文案「近 N 天」） */
  windowDays: number;
  /** 报告生成时刻（ISO），由调用方注入，保证纯函数可测 */
  generatedAt: string;
  /** 参与洞察的账号 × 币种组（按 burnRate 降序、null 置后） */
  accounts: AccountInsight[];
  /** 被跳过的组及原因（credits 订阅账号、快照不足、无消耗） */
  skipped: InsightSkip[];
  /** 按币种的本月预计支出（USD、CNY…各一行） */
  projections: MonthProjection[];
  /** 每个币种消耗最快的账号（至多一名） */
  fastest: FastestAccount[];
  /** 是否有任何可展示的洞察（false 时 UI 显示占位） */
  hasData: boolean;
  /** 摘要条风险等级：任一币种最快账号 daysLeft ≤ 7 → warn，≤ 3 → err */
  risk: InsightRisk;
}

export interface InsightOptions {
  /** 报告时刻（注入以便单测确定化）；缺省取当前时刻 */
  now?: Date | string;
  /** 统计窗口天数；缺省 DEFAULT_INSIGHT_WINDOW_DAYS */
  windowDays?: number;
  /** accountId → 显示名（缺省用 accountId） */
  names?: Record<string, string>;
  /** 只统计这些账号（缺省全部）；用于只看启用账号 */
  accountIds?: Iterable<string>;
}

interface Snap {
  t: number;
  balance: number;
}

/** 解析 ISO 时间戳为毫秒；非法返回 null */
function parseTs(ts: string): number | null {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 本地日期键 YYYY-MM-DD（当月边界按本地日历判断，与用户认知一致） */
function localDayKey(t: number): string {
  const d = new Date(t);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

/**
 * 组内快照整理：解析时间、丢弃非法时间/非法余额、按时间升序。
 * 同一时间戳的多条只保留最后一条（history.json 理论上不会出现，防御性处理）。
 */
function cleanSnaps(raw: BalanceSnapshot[]): Snap[] {
  const parsed: Snap[] = [];
  for (const s of raw) {
    const t = parseTs(s.ts);
    if (t === null) continue;
    if (typeof s.balance !== "number" || !Number.isFinite(s.balance)) continue;
    parsed.push({ t, balance: s.balance });
  }
  parsed.sort((a, b) => a.t - b.t);
  const out: Snap[] = [];
  for (const s of parsed) {
    if (out.length > 0 && out[out.length - 1].t === s.t) out[out.length - 1] = s;
    else out.push(s);
  }
  return out;
}

/** 当日 00:00（本地）的绝对毫秒，用于按「本地日历天」度量跨度（不受夏令时影响） */
function startOfLocalDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 用本地日历天度量跨度（A→B），再叠加首末的日内时间占比：
 * 纯毫秒差在夏令时切换当天会差 1 小时（约 4% 误差），按日历天度量则与用户认知一致。
 */
function calendarSpanDays(first: number, last: number): number {
  const dayDiff = Math.round((startOfLocalDay(last) - startOfLocalDay(first)) / DAY_MS);
  const firstFraction = (first - startOfLocalDay(first)) / DAY_MS;
  const lastFraction = (last - startOfLocalDay(last)) / DAY_MS;
  return Math.max(0, dayDiff + lastFraction - firstFraction);
}

/** 逐对差分累计「下降段」：只会增加，充值（余额上升）不产生负贡献 */
function totalDropOf(snaps: readonly Snap[]): number {
  let drop = 0;
  for (let i = 1; i < snaps.length; i++) {
    const delta = snaps[i - 1].balance - snaps[i].balance;
    if (delta > 0) drop += delta;
  }
  return drop;
}

/** 安全除法：分母为 0 / 非有限、结果非有限时返回 null，杜绝 Infinity 与 NaN 外泄 */
function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** 当月总天数 */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function accountName(names: Record<string, string>, accountId: string): string {
  const n = names[accountId];
  return n && n.trim() ? n : accountId;
}

/** 摘要风险等级：只看「最快账号」的可支撑天数（docs §1.4） */
function riskOf(fastest: readonly FastestAccount[]): InsightRisk {
  let risk: InsightRisk = "ok";
  for (const f of fastest) {
    if (f.daysLeft === null) continue;
    if (f.daysLeft <= 3) return "err";
    if (f.daysLeft <= 7) risk = "warn";
  }
  return risk;
}

/**
 * 主入口：从余额快照 + 当前刷新结果生成洞察报告。
 *
 * - `outcomes` 决定「要统计哪些账号」：**显式 `ok !== true` 的账号被整体排除**
 *   （AC-5 原文：刷新失败不产生洞察，也不登上「消耗最快」，且不影响其他账号的聚合）；
 *   outcomes 为空（纯快照驱动）时不做失败过滤。余额一律取快照，避免与快照口径混用；
 * - 分组键为 (accountId, currency)，币种先归一后再分组，credits/CREDIT 整组跳过并登记原因；
 * - 纯函数：同一输入（含注入的 now）必得同一输出。
 */
export function buildInsightReport(
  snapshots: readonly BalanceSnapshot[],
  outcomes: readonly RefreshOutcome[] = [],
  options: InsightOptions = {},
): InsightReport {
  const windowDays =
    typeof options.windowDays === "number" && Number.isFinite(options.windowDays) && options.windowDays > 0
      ? Math.round(options.windowDays)
      : DEFAULT_INSIGHT_WINDOW_DAYS;
  const now = options.now === undefined ? new Date() : new Date(options.now);
  const nowMs = now.getTime();
  const names = options.names ?? {};

  // 统计范围：显式 accountIds 优先；否则用 outcomes 推导（旧的 get_last_results / refresh_all 结果）
  const accountOrder: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      accountOrder.push(id);
    }
  };
  if (options.accountIds !== undefined) {
    for (const id of options.accountIds) push(id);
  } else {
    for (const o of outcomes) push(o.accountId);
    // 没有 outcomes（纯快照驱动，如单测或仅历史数据）时，账号顺序回退为快照中的出现顺序
    if (accountOrder.length === 0) for (const s of snapshots) push(s.accountId);
  }

  // R14 终审 D-2（按 AC-5 原文）：刷新失败（ok !== true）的账号不产生洞察 —— 这里做**唯一过滤点**，
  // accounts / skipped / fastest / projections 全部由过滤后的列表派生，调用方无需各自处理。
  // 语义：outcomes 为空（纯快照驱动）时不过滤；显式 ok:false 才排除。
  const okAccountIds = new Set(outcomes.filter((o) => o.ok === true).map((o) => o.accountId));
  const failedAccountIds = new Set(outcomes.filter((o) => o.ok !== true).map((o) => o.accountId));
  const includedOrder =
    outcomes.length === 0 ? accountOrder : accountOrder.filter((id) => !failedAccountIds.has(id) || okAccountIds.has(id));
  const included = new Set(includedOrder); // 分组与聚合都只认这批账号
  // 分组键 `${accountId}\u0000${currency}`：accountId 与币种都不含该字符，拼接无歧义
  const groups = new Map<string, { accountId: string; currency: string; raw: BalanceSnapshot[] }>();
  for (const s of snapshots) {
    if (!included.has(s.accountId)) continue;
    const currency = normalizeCurrency(s.currency);
    const key = `${s.accountId}\u0000${currency}`;
    const g = groups.get(key);
    if (g) g.raw.push(s);
    else groups.set(key, { accountId: s.accountId, currency, raw: [s] });
  }

  const accounts: AccountInsight[] = [];
  const skipped: InsightSkip[] = [];
  const monthDropByCurrency = new Map<string, { drop: number; accounts: Set<string> }>();

  for (const id of includedOrder) {
    for (const g of groups.values()) {
      if (g.accountId !== id) continue;
      const name = accountName(names, id);

      // ① 非法币单位（credits 等）：整组跳过，登记原因（AC-4）
      if (shouldSkipCurrency(g.currency)) {
        skipped.push({ accountId: id, currency: g.currency, reason: "nonFiat" });
        continue;
      }

      const all = cleanSnaps(g.raw);
      const inWindow = all.filter((s) => s.t <= nowMs && nowMs - s.t <= windowDays * DAY_MS);
      const series = inWindow.map((s) => s.balance);
      const latest = inWindow.length > 0 ? inWindow[inWindow.length - 1].balance : null;
      const spanDays = inWindow.length >= 2 ? calendarSpanDays(inWindow[0].t, inWindow[inWindow.length - 1].t) : 0;
      const totalDrop = totalDropOf(inWindow);

      let burnRate: number | null = null;
      let reason: AccountInsight["reason"] = null;
      if (inWindow.length < 2 || spanDays < MIN_WINDOW_SPAN_DAYS) {
        reason = "insufficientData"; // 快照不足 / 跨度太短 → 降级
      } else {
        burnRate = totalDrop > 0 ? safeDiv(totalDrop, spanDays) : null;
        if (burnRate === null) reason = "noSpend"; // 无消耗或余额只升不降（充值）
      }

      const daysLeft = burnRate !== null && burnRate > 0 && latest !== null ? safeDiv(latest, burnRate) : null;

      accounts.push({
        accountId: id,
        accountName: name,
        currency: g.currency,
        currentBalance: latest,
        burnRate,
        daysLeft,
        totalDrop,
        spanDays,
        snapshotCount: inWindow.length,
        reason,
        series,
      });

      // ② 当月下降额：只累加当月快照之间的下降段，不跨月边界
      //    （当月仅 1 条快照 → 没有下降段 → monthDrop=0，规格 §1.3）
      const monthKey = localDayKey(nowMs).slice(0, 7);
      const inMonth = inWindow.filter((s) => localDayKey(s.t).slice(0, 7) === monthKey);
      const monthDrop = totalDropOf(inMonth);
      const agg = monthDropByCurrency.get(g.currency) ?? { drop: 0, accounts: new Set<string>() };
      agg.drop += monthDrop;
      agg.accounts.add(id);
      monthDropByCurrency.set(g.currency, agg);

      // 窗口内完全没有可用的消耗信号 → 也登记一条跳过原因，便于 UI 解释「—」
      if (reason !== null) skipped.push({ accountId: id, currency: g.currency, reason });
    }
  }

  // 排序：burnRate 降序（null 置后），同速按账号名稳定排序
  accounts.sort((a, b) => {
    const av = a.burnRate ?? -1;
    const bv = b.burnRate ?? -1;
    if (bv !== av) return bv - av;
    return a.accountName.localeCompare(b.accountName, "zh-CN");
  });

  // ③ 本月预计支出（按币种）：projected = monthDrop + burnRate × remainingDays（规格 §1.3）
  //    速率用 §1.1 的账户级 burnRate（同币种求和），不做「月内速率」二次换算
  const monthDaysElapsed = now.getDate();
  const remainingDays = daysInMonth(now.getFullYear(), now.getMonth()) - monthDaysElapsed;
  const projections: MonthProjection[] = [];
  for (const [currency, agg] of monthDropByCurrency) {
    const burnSum = accounts
      .filter((a) => a.currency === currency && a.burnRate !== null)
      .reduce((sum, a) => sum + (a.burnRate ?? 0), 0);
    // 退化三分支（规格 §1.3）：
    //   ① 无速率且无已发生消耗 → 该币种不产出 projection（调用方按「暂无消耗数据」处理）
    //   ② 无速率但有已发生消耗 → 只展示已发生，degraded=true
    //   ③ 有速率 → 正常外推（即便当月只有 1 条快照、monthDrop=0）
    if (burnSum === 0 && agg.drop === 0) continue;
    const canExtrapolate = burnSum > 0;
    const projectedRemaining = canExtrapolate ? burnSum * remainingDays : 0;
    projections.push({
      currency,
      monthDrop: agg.drop,
      monthDaysElapsed,
      remainingDays,
      projectedTotal: agg.drop + projectedRemaining,
      elapsedSpend: agg.drop,
      projectedRemaining,
      accountCount: agg.accounts.size,
      degraded: !canExtrapolate,
    });
  }
  projections.sort((a, b) => a.currency.localeCompare(b.currency));

  // ④ 消耗最快账号：每个币种至多一名（burnRate 最大且非 null）
  const fastest: FastestAccount[] = [];
  const bestByCurrency = new Map<string, AccountInsight>();
  for (const a of accounts) {
    if (a.burnRate === null) continue;
    const cur = bestByCurrency.get(a.currency);
    if (!cur || (cur.burnRate ?? 0) < a.burnRate) bestByCurrency.set(a.currency, a);
  }
  for (const a of bestByCurrency.values()) {
    fastest.push({
      accountId: a.accountId,
      accountName: a.accountName,
      currency: a.currency,
      burnRate: a.burnRate ?? 0,
      daysLeft: a.daysLeft,
      currentBalance: a.currentBalance,
    });
  }
  fastest.sort((a, b) => b.burnRate - a.burnRate);

  return {
    windowDays,
    generatedAt: Number.isFinite(nowMs) ? now.toISOString() : "",
    accounts,
    skipped,
    projections,
    fastest,
    hasData: accounts.some((a) => a.burnRate !== null) || accounts.some((a) => a.snapshotCount > 0),
    risk: riskOf(fastest),
  };
}

/** 可支撑天数文案：null →「—」；< 1 →「< 1 天」；1–10 → 1 位小数；≥ 10 → 整数（docs §1.2） */
export function formatDaysLeft(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return "—";
  if (days < 1) return "< 1 天";
  if (days < 10) return `${days.toFixed(1)} 天`;
  return `${Math.round(days)} 天`;
}

/** 日均消耗文案：null →「—」；否则按量级自适应小数位 */
export function formatBurnRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate < 0) return "—";
  const digits = rate >= 100 ? 1 : rate >= 1 ? 2 : 4;
  return rate.toFixed(digits);
}

/** 跳过原因文案（UI 展示用） */
export const SKIP_REASON_LABELS: Record<InsightSkipReason, string> = {
  nonFiat: "点数/订阅单位，不适用消耗预测",
  insufficientData: "历史快照不足 2 条或跨度不足 12 小时",
  noSpend: "窗口内无消耗（余额未下降）",
};

/** 「注意」摘要条文案：`「名称」消耗最快：X 币种/天，余额约可支撑 Y 天` */
export function fastestSummaryText(f: FastestAccount): string {
  const days = f.daysLeft === null ? "—" : formatDaysLeft(f.daysLeft);
  return `「${f.accountName}」消耗最快：${formatBurnRate(f.burnRate)} ${f.currency}/天，余额约可支撑 ${days}`;
}

/** 「注意」摘要条风险等级：daysLeft ≤ 7 → warn，≤ 3 → err，否则 ok */
export function fastestRisk(f: FastestAccount): InsightRisk {
  return riskOf([f]);
}
