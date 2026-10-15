// R15 深度分析：纯函数模块，输入 usage-history 记录（+ results.json 的 modelUsage），
// 输出周期对比 / 模型成本排行 / 账号效率 / 异常日。口径严格遵循 docs/round-15-plan.md §3。
//
// 时区纪律（AC-14）：日期键 "YYYY-MM-DD" 就是本地日历日；本模块**从不**用 new Date(字符串) 做日历运算，
// 而是把 "YYYY-MM-DD" 解析成 (y,m,d) 后用本地 Date(y, m-1, d) 加减天数再格式化回字符串。
// 这样在 UTC 与 UTC+8 机器上，同一份 records 得到完全相同的窗口与结果。

import { normalizeCurrency, shouldSkipCurrency } from "./insights";
import type { UsagePoint, UsageRecord } from "./types";

/** 周期对比窗口长度（近 7 天 vs 前 7 天，§3.1） */
export const PERIOD_DAYS = 7;
/** 模型成本排行取前 N（§3.2） */
export const MODEL_TOP_N = 5;
/** 效率排行「请求数下限」：低于此值的账号不参与「最差」标记（§3.3） */
export const MIN_EFFICIENCY_REQUESTS = 10;
/** 异常日窗口（§3.4） */
export const ANOMALY_WINDOW_DAYS = 14;
/** 异常日倍数阈值（§3.4） */
export const ANOMALY_K = 2.5;
/** 异常日最少样本：窗口内有记录日数（§3.4） */
export const ANOMALY_MIN_SAMPLES = 5;
/** 异常日最多输出条数（§3.4） */
export const ANOMALY_MAX_ITEMS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "YYYY-MM-DD" → 本地 Date（零时）；非法返回 null。绝不走 new Date(string) 以免时区漂移 */
function parseDateKey(key: string): Date | null {
  if (!DATE_RE.test(key)) return null;
  const [y, m, d] = key.split("-").map(Number);
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return probe;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地日历日加减（跨月/跨年/夏令时都安全，因为按 (y,m,d) 而不是毫秒运算） */
export function shiftDateKey(key: string, days: number): string {
  const d = parseDateKey(key);
  if (!d) return key;
  return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** 含首尾的本地日历日区间列表 */
export function dateRange(fromKey: string, toKey: string): string[] {
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (!from || !to) return [];
  const out: string[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = to.getTime();
  let guard = 0;
  while (cur.getTime() <= end && guard < 4000) {
    out.push(formatDate(cur));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return out;
}

/** 日期是否落在 [from, to]（闭区间，纯字符串比较即可：YYYY-MM-DD 字典序等价于日期序） */
export function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/** 归一币种为分析用的分组键 */
export function groupCurrency(currency: string): string {
  return normalizeCurrency(currency);
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 求和（null 计 0，返回 0 而不是 NaN） */
function sumOrZero(values: readonly (number | null)[]): number {
  let s = 0;
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) s += v;
  return s;
}

/* ============================ §3.1 周期对比 ============================ */

export interface CostDelta {
  /** 变化后的当前窗口花费 */
  current: number;
  /** 变化前的对比窗口花费 */
  previous: number;
  /** current − previous（绝对差） */
  delta: number;
  /** 变化百分比；对比窗口为 0（无法算比例）时为 null → UI 显示「新增」或「—」 */
  deltaPct: number | null;
  /** deltaPct 为 null 时的语义标签（§3.1 降级规则） */
  label: "新增" | "—" | null;
}

export interface CurrencyPeriod {
  currency: string;
  /** 当前窗口花费合计（cost=null 的行按 0 计） */
  costThis: number;
  /** 对比窗口花费合计 */
  costPrev: number;
  delta: number;
  deltaPct: number | null;
  label: "新增" | "—" | null;
  /** 日均：窗口花费 ÷ 固定分母 7（含无记录日，保证两周可比） */
  dailyAvgThis: number;
  dailyAvgPrev: number;
}

export interface PeriodComparison {
  today: string;
  thisFrom: string;
  thisTo: string;
  prevFrom: string;
  prevTo: string;
  /** 按币种分别对比（credits 排除；跨币种绝不合并，§3.1） */
  byCurrency: CurrencyPeriod[];
  /** 请求数跨币种合计（计数无币种语义） */
  requests: CostDelta & { thisTotal: number; prevTotal: number };
}

function deltaOf(current: number, previous: number): CostDelta {
  const delta = current - previous;
  if (previous > 0) return { current, previous, delta, deltaPct: (delta / previous) * 100, label: null };
  // 对比窗口为 0：无法算比例。本周有花费 → 「新增」；两者皆 0 → 「—」
  return { current, previous, delta, deltaPct: null, label: current > 0 ? "新增" : "—" };
}

/**
 * 近 7 天 vs 前 7 天（§3.1）。
 * @param records 已按启用账号过滤的 usage-history 记录（内部会剔除 credits）
 * @param today   本地日历日 "YYYY-MM-DD"（由调用方注入，便于测试与时区无关）
 */
export function comparePeriods(records: readonly UsageRecord[], today: string): PeriodComparison {
  const thisFrom = shiftDateKey(today, -(PERIOD_DAYS - 1)); // today−6
  const thisTo = today;
  const prevFrom = shiftDateKey(today, -(PERIOD_DAYS * 2 - 1)); // today−13
  const prevTo = shiftDateKey(today, -PERIOD_DAYS); // today−7

  const fiat = records.filter((r) => !shouldSkipCurrency(r.currency));
  const inThis = fiat.filter((r) => inRange(r.date, thisFrom, thisTo));
  const inPrev = fiat.filter((r) => inRange(r.date, prevFrom, prevTo));

  const currencies = [...new Set([...inThis, ...inPrev].map((r) => groupCurrency(r.currency)))].sort();
  const byCurrency: CurrencyPeriod[] = currencies.map((currency) => {
    const costThis = sumOrZero(inThis.filter((r) => groupCurrency(r.currency) === currency).map((r) => r.cost));
    const costPrev = sumOrZero(inPrev.filter((r) => groupCurrency(r.currency) === currency).map((r) => r.cost));
    const d = deltaOf(costThis, costPrev);
    return {
      currency,
      costThis,
      costPrev,
      delta: d.delta,
      deltaPct: d.deltaPct,
      label: d.label,
      dailyAvgThis: costThis / PERIOD_DAYS,
      dailyAvgPrev: costPrev / PERIOD_DAYS,
    };
  });

  // 请求数：跨币种合计（含 credits？§3.1 只说花费按币种、请求跨币种合计；
  // 但 §1.6/§3 统一要求 credits 不参与法币口径，因此这里也用 fiat 集合）
  const reqThis = sumOrZero(inThis.map((r) => r.requests));
  const reqPrev = sumOrZero(inPrev.map((r) => r.requests));
  const reqDelta = deltaOf(reqThis, reqPrev);
  return {
    today,
    thisFrom,
    thisTo,
    prevFrom,
    prevTo,
    byCurrency,
    requests: { ...reqDelta, thisTotal: reqThis, prevTotal: reqPrev },
  };
}

/* ============================ §3.2 模型成本排行 ============================ */

export interface ModelRankEntry {
  /** 显示名（首次出现的原拼写） */
  model: string;
  currency: string;
  cost: number;
  requests: number;
  totalTokens: number;
}

export interface ModelRanking {
  /** 按币种分组的成本榜（不跨币种合计），每组 Top 5 */
  byCurrency: { currency: string; entries: ModelRankEntry[] }[];
  /** 无 cost 数据的模型（按 totalTokens 降序 Top 5），§3.2 降级 */
  noCost: ModelRankEntry[];
  /** 完全没有模型数据 */
  empty: boolean;
}

/**
 * 模型成本排行（§3.2）。数据源是 results.json 的 `modelUsage`（本地总账不含模型维度），跨账号合并。
 * 合并键 = `model.trim().toLowerCase()`；按币种分组（costUnit 归一）；排序 cost↓ → totalTokens↓ → 名称↑。
 */
export function rankModelCosts(
  modelUsageByAccount: ReadonlyMap<string, readonly UsagePoint[] | null | undefined>,
): ModelRanking {
  // key = `${归一币种}\u0000${小写模型}`，同时记录首次出现的显示拼写
  interface Agg {
    display: string;
    currency: string;
    cost: number;
    hasCost: boolean;
    requests: number;
    tokens: number;
    hasTokens: boolean;
  }
  const withCost = new Map<string, Agg>();
  const withoutCost = new Map<string, Agg>();

  for (const points of modelUsageByAccount.values()) {
    for (const p of points ?? []) {
      const rawModel = (p.model ?? "").trim();
      if (rawModel === "") continue;
      const lower = rawModel.toLowerCase();
      const cost = finiteOrNull(p.cost);
      const tokens = finiteOrNull(p.tokens);
      const inOut =
        finiteOrNull(p.inputTokens) !== null || finiteOrNull(p.outputTokens) !== null
          ? (finiteOrNull(p.inputTokens) ?? 0) + (finiteOrNull(p.outputTokens) ?? 0)
          : null;
      const totalTokensOfPoint = tokens ?? inOut;
      const currency = normalizeCurrency(p.costUnit);
      const target = cost === null ? withoutCost : withCost;
      const key = `${currency}\u0000${lower}`;
      const prev = target.get(key);
      if (prev) {
        prev.cost += cost ?? 0;
        prev.requests += finiteOrNull(p.requests) ?? 0;
        if (totalTokensOfPoint !== null) {
          prev.tokens += totalTokensOfPoint;
          prev.hasTokens = true;
        }
        if (cost !== null) prev.hasCost = true;
      } else {
        target.set(key, {
          display: rawModel,
          currency,
          cost: cost ?? 0,
          hasCost: cost !== null,
          requests: finiteOrNull(p.requests) ?? 0,
          tokens: totalTokensOfPoint ?? 0,
          hasTokens: totalTokensOfPoint !== null,
        });
      }
    }
  }

  const toEntry = (a: Agg): ModelRankEntry => ({
    model: a.display,
    currency: a.currency,
    cost: a.cost,
    requests: a.requests,
    totalTokens: a.tokens,
  });

  const byCurrencyMap = new Map<string, ModelRankEntry[]>();
  for (const a of withCost.values()) {
    const list = byCurrencyMap.get(a.currency) ?? [];
    list.push(toEntry(a));
    byCurrencyMap.set(a.currency, list);
  }
  const byCurrency = [...byCurrencyMap.entries()]
    .map(([currency, entries]) => ({
      currency,
      entries: entries
        .sort(
          (x, y) =>
            y.cost - x.cost ||
            y.totalTokens - x.totalTokens ||
            x.model.localeCompare(y.model, "zh-CN"),
        )
        .slice(0, MODEL_TOP_N),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const noCost = [...withoutCost.values()]
    .map(toEntry)
    .sort(
      (x, y) =>
        y.totalTokens - x.totalTokens ||
        y.requests - x.requests ||
        x.model.localeCompare(y.model, "zh-CN"),
    )
    .slice(0, MODEL_TOP_N);

  return { byCurrency, noCost, empty: byCurrency.length === 0 && noCost.length === 0 };
}

/* ============================ §3.3 账号效率对比 ============================ */

export interface EfficiencyEntry {
  accountId: string;
  currency: string;
  cost: number;
  requests: number;
  /** 每请求花费 = 花费 / 请求数；请求数为 0/null → null（显示「—」） */
  costPerRequest: number | null;
  /** 每单位花费的请求数 = 请求数 / 花费；花费为 0/null → null */
  requestsPerUnit: number | null;
  /** 同币种内 costPerRequest 最大且请求数 ≥ 10（§3.3） */
  worst: boolean;
}

export interface EfficiencyReport {
  /** 按币种分组（credits 单独成组，不与其他币种比较） */
  byCurrency: { currency: string; entries: EfficiencyEntry[]; worstAccountId: string | null }[];
  empty: boolean;
}

function safeDiv(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  const r = n / d;
  return Number.isFinite(r) ? r : null;
}

/**
 * 账号效率对比（§3.3）。数据源 = usage-history 窗口内行；跨币种绝不合并；credits 单独成组。
 * 「效率最差」= 同币种内 costPerRequest 最大且请求数 ≥ MIN_EFFICIENCY_REQUESTS(=10)。
 */
export function compareEfficiency(
  records: readonly UsageRecord[],
  today: string,
  windowDays: number = PERIOD_DAYS,
): EfficiencyReport {
  const from = shiftDateKey(today, -(windowDays - 1));
  const scoped = records.filter((r) => inRange(r.date, from, today));

  const grouped = new Map<string, Map<string, { cost: number; requests: number }>>();
  for (const r of scoped) {
    const currency = groupCurrency(r.currency);
    const perAccount = grouped.get(currency) ?? new Map<string, { cost: number; requests: number }>();
    const acc = perAccount.get(r.accountId) ?? { cost: 0, requests: 0 };
    acc.cost += finiteOrNull(r.cost) ?? 0;
    acc.requests += finiteOrNull(r.requests) ?? 0;
    perAccount.set(r.accountId, acc);
    grouped.set(currency, perAccount);
  }

  const byCurrency = [...grouped.entries()]
    .map(([currency, perAccount]) => {
      let entries: EfficiencyEntry[] = [...perAccount.entries()].map(([accountId, v]) => ({
        accountId,
        currency,
        cost: v.cost,
        requests: v.requests,
        costPerRequest: v.requests > 0 ? safeDiv(v.cost, v.requests) : null,
        requestsPerUnit: v.cost > 0 ? safeDiv(v.requests, v.cost) : null,
        worst: false,
      }));
      // 仅有花费无请求的账号 costPerRequest=null，不参与「最差」排名（但仍在榜上显示「—」）
      const eligible = entries.filter(
        (e) => e.costPerRequest !== null && e.requests >= MIN_EFFICIENCY_REQUESTS,
      );
      let worstAccountId: string | null = null;
      if (eligible.length > 0) {
        const worst = eligible.reduce((a, b) => ((b.costPerRequest ?? 0) > (a.costPerRequest ?? 0) ? b : a));
        worstAccountId = worst.accountId;
        entries = entries.map((e) => (e.accountId === worstAccountId ? { ...e, worst: true } : e));
      }
      // 排序：costPerRequest 降序（null 置后）→ accountId 升序，保证稳定
      entries.sort((a, b) => {
        const av = a.costPerRequest ?? -1;
        const bv = b.costPerRequest ?? -1;
        if (bv !== av) return bv - av;
        return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
      });
      return { currency, entries, worstAccountId };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { byCurrency, empty: byCurrency.length === 0 };
}

/* ============================ §3.4 异常日检测 ============================ */

export interface AnomalyDay {
  accountId: string;
  currency: string;
  date: string;
  /** 该日花费 */
  cost: number;
  /** 中位数 */
  median: number;
  /** 倍数 = cost / median，保留 1 位小数 */
  multiple: number;
}

export interface AnomalyReport {
  /** 按花费降序最多 3 条 */
  days: AnomalyDay[];
  /** 参与判定的 (账号,币种) 组数（有记录日数 ≥ 5 且 median > 0 的组） */
  evaluated: number;
  /** 因样本不足/中位数为 0 而未能判定的组数 */
  insufficient: number;
}

/** 中位数（偶数个取中间两值平均）；空数组 → null */
export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * 异常日检测（§3.4）：某 (账号,币种) 在近 14 天内的逐日 cost（含 0 值日，**缺失日不计入**）；
 * `med = median(有记录日)`；触发条件 `cost > med × 2.5`；要求有记录日数 ≥ 5 且 med > 0。
 * credits 排除（§1.6：法币口径）。
 */
export function detectAnomalies(records: readonly UsageRecord[], today: string): AnomalyReport {
  const from = shiftDateKey(today, -(ANOMALY_WINDOW_DAYS - 1));
  const scoped = records.filter((r) => inRange(r.date, from, today) && !shouldSkipCurrency(r.currency));

  // (账号,币种) → date → cost（同日多行求和）
  const groups = new Map<string, { accountId: string; currency: string; byDate: Map<string, number> }>();
  for (const r of scoped) {
    const currency = groupCurrency(r.currency);
    const key = `${r.accountId}\u0000${currency}`;
    const g = groups.get(key) ?? { accountId: r.accountId, currency, byDate: new Map<string, number>() };
    g.byDate.set(r.date, (g.byDate.get(r.date) ?? 0) + (finiteOrNull(r.cost) ?? 0));
    groups.set(key, g);
  }

  const days: AnomalyDay[] = [];
  let evaluated = 0;
  let insufficient = 0;
  for (const g of groups.values()) {
    const costs = [...g.byDate.values()];
    const med = median(costs);
    if (costs.length < ANOMALY_MIN_SAMPLES || med === null || med <= 0) {
      insufficient++;
      continue;
    }
    evaluated++;
    const threshold = med * ANOMALY_K;
    for (const [date, cost] of g.byDate) {
      if (!(cost > threshold)) continue;
      days.push({
        accountId: g.accountId,
        currency: g.currency,
        date,
        cost,
        median: med,
        multiple: Number((cost / med).toFixed(1)),
      });
    }
  }

  days.sort(
    (a, b) =>
      b.cost - a.cost ||
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.accountId < b.accountId ? -1 : 1),
  );
  return { days: days.slice(0, ANOMALY_MAX_ITEMS), evaluated, insufficient };
}

/* ============================ 汇总入口 ============================ */

export interface AnalysisReport {
  today: string;
  period: PeriodComparison;
  models: ModelRanking;
  efficiency: EfficiencyReport;
  anomalies: AnomalyReport;
  /** usage-history 是否有任何记录（false → 分析视图走「暂无本地用量历史」占位，§3.5.4） */
  hasUsageHistory: boolean;
}

export interface AnalysisInput {
  /** usage-history 记录（已按启用账号过滤；内部再做一次 credits 排除） */
  records: readonly UsageRecord[];
  /** results.json 的 modelUsage（accountId → 点集），模型维度唯一来源 */
  modelUsageByAccount?: ReadonlyMap<string, readonly UsagePoint[] | null | undefined>;
  /** 本地日历日 "YYYY-MM-DD"（注入而非取当前时间，保证时区无关与可测） */
  today: string;
}

/** 一次性算出四个指标（UI 一次调用拿全） */
export function buildAnalysis(input: AnalysisInput): AnalysisReport {
  const records = input.records;
  return {
    today: input.today,
    period: comparePeriods(records, input.today),
    models: rankModelCosts(input.modelUsageByAccount ?? new Map()),
    efficiency: compareEfficiency(records, input.today),
    anomalies: detectAnomalies(records, input.today),
    hasUsageHistory: records.length > 0,
  };
}
