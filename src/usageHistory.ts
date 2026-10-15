// R15 本地用量历史：把「本次刷新结果 + 余额快照 + 已有历史」算成一批可 upsert 的 UsageRecord。
// 口径严格遵循 docs/round-15-plan.md §1.2（B1 余额下降法 / B2 used 计数器法）与 §1.3（键与覆盖规则）。
//
// 职责边界：本模块只**生成批次**；真正的合并 / 清理 / 幂等 / 原子写由 Rust 侧 upsert_usage_history 负责
//（唯一合并点）。这里的 mergeUsageRecords 仅用于「乐观更新本地视图」与「判断批次是否变化」。
//
// 时区纪律（AC-14）：所有日期键一律按**本地日历日**计算；"YYYY-MM-DD" 字符串本身就是本地日历日，
// 不再经 new Date() 二次换算（否则在 UTC 机器与 UTC+8 机器上会得到不同日期）。

import { normalizeCurrency, shouldSkipCurrency } from "./insights";
import type { BalanceSnapshot, RefreshOutcome, UsageRecord } from "./types";

/** 合法的本地日历日 "YYYY-MM-DD" */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 时间戳 → 本地日历日 "YYYY-MM-DD"。
 * - 已带时区偏移（Z / ±HH:MM）的 ISO 串：取**该时间戳自身时区**的日历日
 *   （避免 +08:00 的 00:30 在 UTC 机器上被算成前一天）；
 * - 无时区的本地时间串 / Date：按本机日历换算。
 */
export function localDateKey(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") {
    const s = input.trim();
    if (s === "") return "";
    const hasTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
    if (!hasTime) {
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : "";
    }
    const tz = s.match(/(Z|[+-]\d{2}:?\d{2})$/);
    if (tz) {
      // 时区标识「换成 UTC」再取 UTC 日历日 == 该时间戳自身时区的日历日
      const asUtc = s.endsWith("Z") ? s : `${s.slice(0, -tz[1].length)}Z`;
      const d = new Date(asUtc);
      if (Number.isNaN(d.getTime())) return "";
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 「今天」的本地日历日键（UI 层取当前日期用；测试请直接注入日期字符串） */
export function toLocalDateKey(d: Date = new Date()): string {
  return localDateKey(d);
}

/** 校验并规范化日期键：非 "YYYY-MM-DD" 或非法日期 → null */
export function isValidDateKey(date: string): boolean {  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/** token 口径（与 reportCsv.ts#tokenCell 一致）：优先 tokens，否则 input+output，两者都缺 → null */
export function totalTokens(r: Pick<UsageRecord, "tokens" | "inputTokens" | "outputTokens">): number | null {
  if (typeof r.tokens === "number" && Number.isFinite(r.tokens)) return r.tokens;
  const hasIn = typeof r.inputTokens === "number" && Number.isFinite(r.inputTokens);
  const hasOut = typeof r.outputTokens === "number" && Number.isFinite(r.outputTokens);
  if (!hasIn && !hasOut) return null;
  return (hasIn ? (r.inputTokens as number) : 0) + (hasOut ? (r.outputTokens as number) : 0);
}

/** 有限数字或 null（NaN/Infinity 一律归一为 null，杜绝脏值进历史文件） */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 全空行判定（AC-3「空日不写」）：**当且仅当**六个数值字段全为 null 时视为无信息行。
 * 为什么必须跳过：站点常返回 `{date, cost:null, requests:null, tokens:null}` 这类占位行，
 * 落盘后会被异常日检测当成「有记录日、cost=0」，压低中位数 → 错误的异常信号（或掩盖真实异常）。
 * 注意：`usedTotal != null` 的行**不算全空** —— B2 基准行正是靠它做下次差分（AC-9 澄清的前提）。
 */
export function isEmptyUsageRow(r: {
  cost: number | null;
  requests: number | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usedTotal: number | null;
}): boolean {
  return (
    r.cost === null &&
    r.requests === null &&
    r.tokens === null &&
    r.inputTokens === null &&
    r.outputTokens === null &&
    r.usedTotal === null
  );
}

/**
 * 站点行的币种解析（§1.2 A）：归一(costUnit) → 非法币代码则回退 balance.currency → "UNKNOWN"。
 * 注意：这里**不**跳过 credits —— §1.6 要求 credits 记录照常写入，只在分析/报表口径里排除。
 */
export function siteCurrency(costUnit: string | null | undefined, balanceCurrency: string | null | undefined): string {
  const fromUnit = normalizeCurrency(costUnit);
  // costUnit 可能是 "%" 之类的非币种标记 → 视为无信息，回退余额币种
  if (fromUnit !== "UNKNOWN" && /^[A-Z]{2,8}$/.test(fromUnit)) return fromUnit;
  return normalizeCurrency(balanceCurrency);
}

export interface BuiltUsageBatch {
  records: UsageRecord[];
  /** B2 被跳过的原因（余额与 used 均为空；无可写数据） */
  skipped: { accountId: string; reason: "noData" }[];
}

/**
 * §1.2 A：站点行（权威）。对每个启用账号的 `info.dailyUsage[].date` 产出一行。
 * 只处理传入的账号（调用方先按启用账号过滤），与刷新失败账号无关（失败时 info 为空，自然无行）。
 * AC-3「空日不写」：六个数值字段全为 null 的占位行**不产出**（见 isEmptyUsageRow）。
 */
export function siteRecordsFromOutcomes(
  outcomes: readonly RefreshOutcome[],
  updatedAt: string,
): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of outcomes) {
    if (!o.ok || !o.info) continue;
    const daily = o.info.dailyUsage ?? [];
    const balanceCurrency = o.info.balance?.currency ?? null;
    for (const p of daily) {
      const date = localDateKey(p.date);
      if (!isValidDateKey(date)) continue;
      const record: UsageRecord = {
        accountId: o.accountId,
        date,
        cost: numOrNull(p.cost),
        currency: siteCurrency(p.costUnit, balanceCurrency),
        requests: numOrNull(p.requests),
        inputTokens: numOrNull(p.inputTokens),
        outputTokens: numOrNull(p.outputTokens),
        tokens: numOrNull(p.tokens),
        usedTotal: null,
        source: "site",
        updatedAt,
      };
      if (isEmptyUsageRow(record)) continue; // 全空行不落盘
      out.push(record);
    }
  }
  return out;
}

/**
 * §1.2 B1：本地行（余额下降法）。
 * - 只取传入账号的快照，按 ts 升序；对每对相邻且**同归一币种**的快照算 `drop = max(0, 前 − 后)`；
 * - drop 计入**后一条快照**的本地日期（因此「昨日末笔 → 今日首笔」的下降额自然记入今日，AC-6）；
 * - 同一 (账号, 日期) 的多个 drop 求和 → **整日重算，天然幂等**（AC-3）；
 * - 首条无前驱不产出行；drop = 0 的日子不产出行。
 */
export function localRecordsFromSnapshots(
  accountIds: readonly string[],
  snapshots: readonly BalanceSnapshot[],
  updatedAt: string,
): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const accountId of accountIds) {
    const hits = snapshots.filter((s) => s.accountId === accountId);
    if (hits.length < 2) continue;
    const cleaned = hits
      .map((s) => ({ t: new Date(s.ts).getTime(), balance: s.balance, currency: normalizeCurrency(s.currency), date: localDateKey(s.ts) }))
      .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.balance) && isValidDateKey(s.date))
      .sort((a, b) => a.t - b.t);

    // 同一日期 → 累计 drop 与其币种
    const byDate = new Map<string, { cost: number; currency: string }>();
    for (let i = 1; i < cleaned.length; i++) {
      const prev = cleaned[i - 1];
      const cur = cleaned[i];
      if (prev.currency !== cur.currency) continue; // 跨币种不混算
      const drop = prev.balance - cur.balance;
      if (drop <= 0) continue; // 充值免疫
      const acc = byDate.get(cur.date) ?? { cost: 0, currency: cur.currency };
      acc.cost += drop;
      byDate.set(cur.date, acc);
    }
    for (const [date, acc] of byDate) {
      out.push({
        accountId,
        date,
        cost: acc.cost,
        currency: acc.currency,
        requests: null,
        inputTokens: null,
        outputTokens: null,
        tokens: null,
        usedTotal: null,
        source: "local",
        updatedAt,
      });
    }
  }
  return out;
}

/**
 * §1.2 B2：本地行（used 计数器法，仅当 `balance == null 且 used != null`，如 Kimi 订阅）。
 * `delta = max(0, usedNow − usedTotalRow)`；`usedTotalRow` = 该账号已有记录中最近一条 `usedTotal != null` 的值，
 * 无则视为首次观察（delta = 0，不产生花费行，但**仍写一条 usedTotal 基准行**，否则下次永远算不出 delta）。
 * 重复刷新同一状态 → delta = 0 → 幂等。
 */
export function localRecordsFromUsedCounter(
  outcomes: readonly RefreshOutcome[],
  existing: readonly UsageRecord[],
  updatedAt: string,
  dateKey?: string,
): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const o of outcomes) {
    if (!o.ok || !o.info || !o.info.used) continue;
    if (o.info.balance) continue; // 有余额走 B1，不走 used 计数器
    const usedNow = numOrNull(o.info.used.amount);
    if (usedNow === null) continue;
    const currency = normalizeCurrency(o.info.used.currency);
    // D-2：日期优先用调用方注入的**本地日历日**（todayKey）；
    // 仅当未注入时才从 updatedAt 推导 —— 直接对 toISOString() 取日期在 UTC+8 的
    // 00:00–08:00 时段会落到前一天（如 2026-10-15T20:30Z 的本地日是 10-16）。
    const date = dateKey !== undefined ? dateKey : localDateKey(updatedAt);
    if (!isValidDateKey(date)) continue;

    // 该账号最近一条带 usedTotal 的记录（按日期降序；同日期取 updatedAt 最新）
    const prior = existing
      .filter((r) => r.accountId === o.accountId && r.usedTotal !== null && Number.isFinite(r.usedTotal))
      .sort((a, b) => (a.date === b.date ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.date < b.date ? 1 : -1))[0];
    const baseline = prior ? (prior.usedTotal as number) : null;
    const delta = baseline === null ? 0 : Math.max(0, usedNow - baseline);

    // 同日已有 local 行则叠加（§1.2 B2：cost = (同日已有 local 行的 cost ?? 0) + delta）
    const sameDayLocal = existing.find(
      (r) => r.accountId === o.accountId && r.date === date && r.source === "local",
    );
    const cost = (sameDayLocal?.cost ?? 0) + delta;

    out.push({
      accountId: o.accountId,
      date,
      cost,
      currency,
      requests: null,
      inputTokens: null,
      outputTokens: null,
      tokens: null,
      usedTotal: usedNow,
      source: "local",
      updatedAt,
    });
  }
  return out;
}

/**
 * 批次生成总入口：站点行 + B1 + B2（同 (账号,日期) 内 local 行合并）。
 * 只处理 `accountIds`（调用方传启用账号），避免给已删除/停用账号写历史。
 * @param dateKey 本地日历日 "YYYY-MM-DD"（todayKey）—— B2 行日期用它，不要再从 updatedAt 推导（D-2）。
 * @param updatedAt 写入时刻（ISO），用于记录的时间戳字段
 */
export function buildUsageBatch(
  outcomes: readonly RefreshOutcome[],
  snapshots: readonly BalanceSnapshot[],
  existing: readonly UsageRecord[],
  accountIds: readonly string[],
  updatedAt: string = new Date().toISOString(),
  dateKey?: string,
): BuiltUsageBatch {
  const enabled = new Set(accountIds);
  const scopedOutcomes = outcomes.filter((o) => enabled.has(o.accountId));

  const site = siteRecordsFromOutcomes(scopedOutcomes, updatedAt);
  const localBalance = localRecordsFromSnapshots(accountIds, snapshots, updatedAt);
  const localUsed = localRecordsFromUsedCounter(scopedOutcomes, existing, updatedAt, dateKey);

  // 同一 (账号,日期) 的 local 行合并：余额法 + used 法都可能产出，cost 相加、币种取已存在者
  const localByKey = new Map<string, UsageRecord>();
  for (const r of [...localBalance, ...localUsed]) {
    const key = `${r.accountId}\u0000${r.date}`;
    const prev = localByKey.get(key);
    if (!prev) {
      localByKey.set(key, { ...r });
      continue;
    }
    localByKey.set(key, {
      ...prev,
      cost: (prev.cost ?? 0) + (r.cost ?? 0),
      usedTotal: r.usedTotal ?? prev.usedTotal,
      updatedAt,
    });
  }

  const records = mergeUsageRecords([...localByKey.values(), ...site]);
  const skipped: BuiltUsageBatch["skipped"] = [];
  for (const id of accountIds) {
    const has = records.some((r) => r.accountId === id);
    if (!has) skipped.push({ accountId: id, reason: "noData" });
  }
  return { records, skipped };
}

/** 键 = (accountId, date) */
export function recordKey(r: Pick<UsageRecord, "accountId" | "date">): string {
  return `${r.accountId}\u0000${r.date}`;
}

/**
 * 兜底合并（§1.3）：键 = (accountId, date)；**site 覆盖 local，local 永不覆盖 site**；同 source 新值覆盖旧值。
 * 权威合并点是 Rust 侧 upsert_usage_history；这里用于乐观更新本地视图与「批次是否有变化」的判断。
 * 同一 accountId 的多个账号对象不会被合并（键含 accountId）。
 */
export function mergeUsageRecords(records: readonly UsageRecord[]): UsageRecord[] {
  const map = new Map<string, UsageRecord>();
  for (const r of records) {
    if (!isValidDateKey(r.date)) continue;
    const key = recordKey(r);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
      continue;
    }
    if (prev.source === "site" && r.source === "local") continue; // site 优先，local 不覆盖
    map.set(key, { ...r }); // 同 source → 新值覆盖；local→site → 升级
  }
  // 稳定输出顺序（按账号、日期升序），便于幂等比较与测试断言
  return [...map.values()].sort((a, b) =>
    a.accountId === b.accountId ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.accountId < b.accountId ? -1 : 1,
  );
}

/** 逐字段比较两批记录是否等价（用于幂等：不做无意义写盘） */
export function sameUsageRecords(a: readonly UsageRecord[], b: readonly UsageRecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.accountId !== y.accountId || x.date !== y.date) return false;
    if (x.cost !== y.cost || x.currency !== y.currency || x.source !== y.source) return false;
    if (x.requests !== y.requests || x.tokens !== y.tokens) return false;
    if (x.inputTokens !== y.inputTokens || x.outputTokens !== y.outputTokens) return false;
    if (x.usedTotal !== y.usedTotal) return false;
  }
  return true;
}

/** 该批次是否会在服务端产生变化（无变化则无需 upsert，等价于 §1.3 幂等） */
export function hasUsageChanges(proposed: readonly UsageRecord[], existing: readonly UsageRecord[]): boolean {
  return !sameUsageRecords(mergeUsageRecords(proposed), mergeUsageRecords(existing));
}

/** 站点与本地合并去重后的视图（§3.5）：同一 (账号,日期) 保留 site 行 */
export function mergedView(existing: readonly UsageRecord[]): UsageRecord[] {
  return mergeUsageRecords(existing);
}

/** 剔除 credits/CREDIT（§1.6：法币口径一律排除点数/订阅单位） */
export function fiatRecords(records: readonly UsageRecord[]): UsageRecord[] {
  return records.filter((r) => !shouldSkipCurrency(r.currency));
}

/** 供 UI/测试使用的空历史封套 */
export function emptyUsageHistory(): { version: number; records: UsageRecord[] } {
  return { version: 1, records: [] };
}
