// R14 报表导出：把「每账号 × 每日」用量与余额快照拼成 CSV 文本（纯函数）。
// 口径见 docs/round-14-plan.md §4：
//   - 首字符 \uFEFF（UTF-8 BOM），Excel 打开中文不乱码；
//   - RFC 4180 转义（含 , " 换行 的字段用双引号包裹，内部 " 双写）、行尾 \r\n；
//   - 数字用 String(number) 原始最短十进制（不千分位、不补零），空值一律空字符串；
//   - 不产生 undefined / null / NaN 字样。
// R14 终审 D-1：credits/CREDIT 币种的行不导出（AC-4 原文），与洞察侧口径一致。
// 本模块只负责「生成文本」，写盘由 Rust 侧 export_csv 命令完成。

import { normalizeCurrency, shouldSkipCurrency } from "./insights";
import { PROVIDER_KINDS } from "./types";
import type { AccountConfig, BalanceSnapshot, RefreshOutcome, UsagePoint } from "./types";

/** 表头（中文，顺序固定，见 docs §4） */
export const USAGE_CSV_HEADERS = [
  "账号名称",
  "账号类型",
  "币种",
  "日期",
  "当日花费",
  "当日请求数",
  "当日Token",
  "当日余额快照",
] as const;

/** UTF-8 BOM：Excel 识别 UTF-8 中文的锚点 */
export const UTF8_BOM = "\uFEFF";

const CRLF = "\r\n";

/** 非法/非有限数字 → 空字符串（禁止 null/NaN 漏进 CSV） */
function numCell(v: number | null | undefined): string {
  if (v === null || v === undefined || typeof v !== "number" || !Number.isFinite(v)) return "";
  return String(v);
}

/** 含分隔符/引号/换行的字段加双引号，内部双引号双写（RFC 4180） */
export function escapeCsvField(value: string): string {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 本地日期键 YYYY-MM-DD（快照 ts 可能带时区偏移，按本地日历归档，与用户看到的日期一致） */
export function localDateKey(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

/**
 * 归一到 YYYY-MM-DD（报表按「天」归档，不因本机时区改变结论）：
 * - 纯日期 `YYYY-MM-DD`：直接返回，不做任何换算；
 * - 带显式时区偏移/`Z` 的 ISO 时间戳：取**其自身时区**的日历日期（同一天的快照不会因本机时区被拆到两天）；
 * - 无时区的本地时间字符串：取字面日期部分；
 * - 其他可解析字符串：按本机日历换算；
 * - 无法解析时返回空串（该行日期不可用）。
 */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/; // 有日期+时间前缀、但无时区标识
const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/; // 结尾的时区偏移

export function normalizeDateKey(raw?: string | null): string {
  const s = (raw ?? "").trim();
  if (s === "") return "";
  const datePrefix = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!datePrefix) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : localDateKey(d);
  }
  const hasTime = LOCAL_DATETIME.test(s);
  // 纯日期 / 无时区的本地时间：字面日期即用户看到的那一天
  if (!hasTime) return datePrefix[1];
  const tz = s.match(TZ_SUFFIX);
  if (!tz) return datePrefix[1];
  // 带时区偏移：先取「该时间戳自身时区的日历日」，再用 UTC 读取 —— 结果与本机时区无关。
  // （直接把 ISO 串丢给 Date 会按本机时区换算，+08:00 的 00:30 在 UTC 机器上会被算成前一天。）
  const asUtc = s.slice(-1) === "Z" ? s : `${s.slice(0, -tz[1].length)}Z`;
  const d = new Date(asUtc);
  if (Number.isNaN(d.getTime())) return datePrefix[1];
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

/** 每日 token 数：优先 tokens，否则 input+output（两者都缺则视为无数据） */
function tokenCell(p: UsagePoint | undefined): string {
  if (!p) return "";
  if (typeof p.tokens === "number" && Number.isFinite(p.tokens)) return String(p.tokens);
  const hasIn = typeof p.inputTokens === "number" && Number.isFinite(p.inputTokens);
  const hasOut = typeof p.outputTokens === "number" && Number.isFinite(p.outputTokens);
  if (!hasIn && !hasOut) return "";
  return String((hasIn ? (p.inputTokens as number) : 0) + (hasOut ? (p.outputTokens as number) : 0));
}

/** 账号类型显示名（与设置页 badge 一致，取 PROVIDER_KINDS label） */
export function kindLabelOf(kind: string): string {
  return PROVIDER_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export interface BuildCsvOptions {
  /** 只导出这些账号（缺省全部）；用于只看启用账号 */
  accountIds?: Iterable<string>;
}

/**
 * 逐行币种解析（R14 终审 N-1，三个层次统一成同一条规则）：
 *   ① 当日 `dailyUsage.costUnit` → ② 当日快照 `currency` → ③ 账号级报表币种。
 * 任一环节命中 credits/CREDIT 即返回 null —— 调用方据此**不导出该日行**
 * （不能直接落到账号级币种，否则「credits 花费日且当日无快照」会被误标成法币导出）。
 * 非币种单位（如 % / costUnit 缺失）视为「无信息」，继续往下一层回落。
 */
function rowCurrencyOf(
  dayPoint: UsagePoint | undefined,
  daySnap: { currency: string } | undefined,
  accountCurrency: string,
): string | null {
  const raw = normalizeCurrency(dayPoint?.costUnit);
  const fromCost = raw !== "UNKNOWN" && /^[A-Z]{2,8}$/.test(raw) ? raw : null;
  const fromSnap = daySnap ? normalizeCurrency(daySnap.currency) : null;
  for (const candidate of [fromCost, fromSnap, accountCurrency]) {
    if (candidate === null) continue;
    if (shouldSkipCurrency(candidate)) return null; // 命中点数/订阅单位 → 该行不导出
    return candidate;
  }
  return null;
}

/**
 * 生成用量报表 CSV 文本。
 *
 * 行集合：每个账号 × union(dailyUsage[].date, 该账号快照的本地日期)，日期升序；
 * 账号顺序保持传入顺序（与看板卡片、设置列表一致），保证导出结果可预期。
 *
 * R14 终审 D-1（按 AC-4 原文）：币种为 credits/CREDIT 的账号**不产生任何行**，
 * 与洞察侧「点数/订阅类整体跳过」保持同一口径；判定复用 insights.ts 的
 * SKIP_CURRENCIES，不在本模块重复字面量。
 */
export function buildUsageCsv(
  accounts: readonly AccountConfig[],
  outcomes: readonly RefreshOutcome[],
  snapshots: readonly BalanceSnapshot[],
  options: BuildCsvOptions = {},
): string {
  const filter = options.accountIds === undefined ? null : new Set(options.accountIds);

  // outcome 索引：dailyUsage 的取数来源（缺失该账号时视为无每日用量）
  const outcomeById = new Map<string, RefreshOutcome>();
  for (const o of outcomes) if (!outcomeById.has(o.accountId)) outcomeById.set(o.accountId, o);

  const lines: string[] = [USAGE_CSV_HEADERS.map((h) => escapeCsvField(h)).join(",")];

  for (const acc of accounts) {
    if (filter !== null && !filter.has(acc.id)) continue;

    const daily = outcomeById.get(acc.id)?.info?.dailyUsage ?? [];
    const byDate = new Map<string, UsagePoint>();
    for (const p of daily) {
      const key = normalizeDateKey(p.date);
      if (key === "") continue;
      byDate.set(key, p);
    }

    // 快照按本地日期分组，保留当日 ts 最大（最新）的一条
    const snaps = snapshots.filter((s) => s.accountId === acc.id);
    const latestByDate = new Map<string, { balance: number; t: number; currency: string }>();
    for (const s of snaps) {
      const key = normalizeDateKey(s.ts);
      if (key === "" || typeof s.balance !== "number" || !Number.isFinite(s.balance)) continue;
      const t = new Date(s.ts).getTime();
      const prev = latestByDate.get(key);
      if (!prev || t >= prev.t) latestByDate.set(key, { balance: s.balance, t, currency: s.currency });
    }

    // 币种：优先当日花费的单位（costUnit），否则最近一条快照的币种（dailyUsage 的 costUnit 可能是 % 等非币种）
    // D-1：把点数/订阅类单位排除在候选之外，避免 credits 抢先占位后被整体跳过
    const latestAny = [...latestByDate.values()].sort((a, b) => b.t - a.t)[0];
    const costCurrencies = daily
      .map((p) => normalizeCurrency(p.costUnit))
      .filter((c) => c !== "UNKNOWN" && /^[A-Z]{2,8}$/.test(c) && !shouldSkipCurrency(c));
    const currency =
      costCurrencies[0] ?? (latestAny ? normalizeCurrency(latestAny.currency) : normalizeCurrency(undefined));

    // D-1：该账号整体是点数/订阅类币种 → 该账号一行都不导出
    if (shouldSkipCurrency(currency)) continue;

    const dates = [...new Set([...byDate.keys(), ...latestByDate.keys()])].sort();
    for (const date of dates) {
      const point: UsagePoint | undefined = byDate.get(date);
      const snap = latestByDate.get(date);
      // N-1：逐行按「当日 costUnit → 当日快照 currency → 账号级币种」解析；
      // 任一环节命中 credits/CREDIT 则该日行不导出（详见 rowCurrencyOf 注释）
      const rowCurrency = rowCurrencyOf(point, snap, currency);
      if (rowCurrency === null) continue;
      const cells = [
        acc.name || "未命名账号",
        kindLabelOf(acc.kind),
        rowCurrency,
        date,
        numCell(point?.cost),
        numCell(point?.requests),
        tokenCell(point),
        snap ? numCell(snap.balance) : "",
      ];
      lines.push(cells.map((c) => escapeCsvField(c)).join(","));
    }
  }

  return UTF8_BOM + lines.join(CRLF) + CRLF;
}

/** 默认导出文件名（本地日期，便于按日归档） */
export function defaultCsvFileName(now: Date | number | string = new Date()): string {
  return `llm-usage-${localDateKey(now)}.csv`;
}
