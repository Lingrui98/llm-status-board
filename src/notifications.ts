// 通知与提醒：从 RefreshOutcome[] 纯前端推导通知，不动 Rust 端。
// 全部为纯函数（localStorage 读写有 try/catch 兜底），便于单测。

import { formatDecimal } from "./format";
import type { QuotaWindow, RefreshOutcome, Settings } from "./types";
// credits/CNY 币种集与「跳过」判定是语义而非阈值，与洞察模块共用同一份定义（避免两处漂移）
import { isCnyCurrency, normalizeCurrency, resolveInsightWindowDays, shouldSkipCurrency } from "./insights";

/** 通知类型：余额不足 / 刷新失败 / 配额将满 / 已恢复（低优先级） */
export type NotificationKind = "lowBalance" | "refreshError" | "quotaFull" | "recovered";

/** 视觉严重度：直接映射 --err / --warn / --ok 语义色 */
export type NotificationSeverity = "err" | "warn" | "ok";

export interface AppNotification {
  /** 稳定 id：`${kind}:${accountId}`（recovered 为 `recovered:${kind}:${accountId}`）。
   *  同一账号同一问题多次刷新得到相同 id —— 这是去重与已读持久化的锚点 */
  id: string;
  kind: NotificationKind;
  accountId: string;
  accountName: string;
  title: string;
  detail?: string;
  /** ISO 时间戳（问题类取刷新时刻 / info.fetchedAt；恢复类取检测时刻） */
  at: string;
  severity: NotificationSeverity;
}

export const KIND_LABELS: Record<NotificationKind, string> = {
  lowBalance: "余额不足",
  refreshError: "刷新失败",
  quotaFull: "配额将满",
  recovered: "已恢复",
};

export interface NotifyThresholds {
  /** USD 及其他法币的低余额阈值 */
  lowBalanceUsd: number;
  /** CNY 低余额阈值（独立默认值，见下方案说明） */
  lowBalanceCny: number;
  /** 配额窗口用量百分比提醒线（0-100） */
  quotaPercent: number;
}

/**
 * 默认阈值。CNY 阈值方案：采用独立默认值 7（≈ $1 的常见汇率量级），
 * 而非按汇率实时折算 —— 阈值语义是「提醒线」不是精确换算，独立默认值
 * 确定性强、无汇率漂移、用户可预期；其余法币一律走 USD 阈值。
 */
export const DEFAULT_NOTIFY_THRESHOLDS: NotifyThresholds = {
  lowBalanceUsd: 1,
  lowBalanceCny: 7,
  quotaPercent: 85,
};

/**
 * R14：把可选设置解析为可直接使用的阈值（旧配置缺字段 → 默认值）。
 * 非法数值（非有限、超界、配额不在 (0,100]）一律回退默认值 —— 配置可能被手工编辑。
 */
export function resolveNotifyThresholds(settings?: Settings | null): NotifyThresholds {
  const fallback = DEFAULT_NOTIFY_THRESHOLDS;
  const num = (v: number | null | undefined, def: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : def;
  return {
    lowBalanceUsd: num(settings?.notifyLowBalanceUsd, fallback.lowBalanceUsd, 0, 10000),
    lowBalanceCny: num(settings?.notifyLowBalanceCny, fallback.lowBalanceCny, 0, 100000),
    quotaPercent: num(settings?.notifyQuotaPercent, fallback.quotaPercent, 1, 100),
  };
}

/** R14：提醒总开关；缺省（undefined/null）视为开启，保证旧配置行为不变 */
export function isNotifyEnabled(settings?: Settings | null): boolean {
  return settings?.notifyEnabled ?? true;
}

/** R14：可配置化的提醒阈值（含总开关），供设置面板直接编辑 */
export interface ResolvedAlertSettings extends NotifyThresholds {
  enabled: boolean;
  /** 洞察统计窗口（天），同时供 insights.ts 使用 */
  insightWindowDays: number;
}

/** R14：设置 → 生效中的提醒配置（唯一解析入口，设置面板与通知计算共用） */
export function resolveAlertSettings(settings?: Settings | null): ResolvedAlertSettings {
  return {
    ...resolveNotifyThresholds(settings),
    enabled: isNotifyEnabled(settings),
    insightWindowDays: resolveInsightWindowDays(settings),
  };
}

/**
 * 提醒口径的优先级：USD 阈值 → 其他法币，CNY 币种集 → CNY 阈值。
 * 非法币单位（credits 等点数）返回 null，表示不适用低余额提醒。
 */
export function balanceThresholdFor(currency: string, thresholds: NotifyThresholds): number | null {
  const cur = normalizeCurrency(currency);
  if (shouldSkipCurrency(cur)) return null;
  return isCnyCurrency(cur) ? thresholds.lowBalanceCny : thresholds.lowBalanceUsd;
}

/** 提醒线只作用于余额/配额两类「提醒」，刷新失败是事实，不受总开关影响 */
export function isAlertKind(kind: NotificationKind): boolean {
  return kind === "lowBalance" || kind === "quotaFull";
}

/**
 * R14：总开关关闭时丢弃提醒类通知与对应问题键（refreshError 保留）。
 * 一并过滤问题键是必要的：恢复检测以问题键为基准，若问题键残留，
 * 重新开启开关后会凭空产生一批「已恢复」通知。
 */
export function filterAlertsDisabled(result: {
  notifications: AppNotification[];
  problemKeys: Set<string>;
}): { notifications: AppNotification[]; problemKeys: Set<string> } {
  return {
    notifications: result.notifications.filter((n) => !isAlertKind(n.kind)),
    problemKeys: new Set([...result.problemKeys].filter((k) => !isAlertProblemKey(k))),
  };
}

function isAlertProblemKey(key: string): boolean {
  const ref = parseProblemKey(key);
  return ref !== null && isAlertKind(ref.kind);
}

/** 额度/点数类单位不是法币，低余额提醒对它们无意义，直接跳过（定义见 insights.ts#shouldSkipCurrency） */

/** 问题键：`${kind}:${accountId}`，作为当前异常集合的元素与恢复检测的比对单位 */
export function problemKey(kind: NotificationKind, accountId: string): string {
  return `${kind}:${accountId}`;
}

export function parseProblemKey(key: string): { kind: NotificationKind; accountId: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  if (kind !== "lowBalance" && kind !== "refreshError" && kind !== "quotaFull") return null;
  return { kind, accountId: key.slice(i + 1) };
}

/** 恢复类通知 id 前缀：recovered 通知与源问题通过去掉前缀后的 problemKey 关联 */
export const RECOVERED_PREFIX = "recovered:";

function accountName(names: Record<string, string>, accountId: string): string {
  const n = names[accountId];
  return n && n.trim() ? n : accountId;
}

/**
 * 核心纯函数：从一批刷新结果推导「当前存在的问题通知」。
 * 去重天然成立 —— 每个 (账号, 类型) 组合每次计算至多产出一条，且 id 稳定。
 *
 * @param outcomes  刷新结果（调用方应先按「当前启用账号」过滤）
 * @param names     accountId → 账号显示名
 * @param thresholds 提醒阈值（默认 DEFAULT_NOTIFY_THRESHOLDS）
 * @param now       失败类通知的时间戳回退值（如 lastRefreshAt）；缺省取当前时刻
 */
export function computeProblemNotifications(
  outcomes: RefreshOutcome[],
  names: Record<string, string>,
  thresholds: NotifyThresholds = DEFAULT_NOTIFY_THRESHOLDS,
  now: string = new Date().toISOString(),
): { notifications: AppNotification[]; problemKeys: Set<string> } {
  const notifications: AppNotification[] = [];
  const problemKeys = new Set<string>();

  for (const o of outcomes) {
    const name = accountName(names, o.accountId);
    const at = o.info?.fetchedAt || now;

    // b) 刷新失败：错误文本入通知；失败时不再检查余额/配额（info 通常为空）
    if (!o.ok) {
      problemKeys.add(problemKey("refreshError", o.accountId));
      notifications.push({
        id: problemKey("refreshError", o.accountId),
        kind: "refreshError",
        accountId: o.accountId,
        accountName: name,
        title: KIND_LABELS.refreshError,
        detail: o.error?.trim() || "刷新失败（无错误详情）",
        at,
        severity: "err",
      });
      continue;
    }

    const info = o.info;
    if (!info) continue;

    // a) 余额不足：法币按币种阈值判断；credits 等点数单位跳过
    const b = info.balance;
    if (b) {
      const threshold = balanceThresholdFor(b.currency, thresholds);
      if (threshold !== null && b.amount < threshold) {
        const isCny = isCnyCurrency(b.currency);
        problemKeys.add(problemKey("lowBalance", o.accountId));
        notifications.push({
          id: problemKey("lowBalance", o.accountId),
          kind: "lowBalance",
          accountId: o.accountId,
          accountName: name,
          title: KIND_LABELS.lowBalance,
          detail: `当前余额 ${formatDecimal(b.amount)} ${b.currency}，低于提醒阈值 ${formatDecimal(threshold)} ${isCny ? "CNY" : "USD"}`,
          at,
          severity: "warn",
        });
      }
    }

    // c) 配额将满：同一账号的多个越线窗口聚合为一条通知（不堆积）
    const hot = (info.quotaWindows ?? []).filter(
      (w): w is QuotaWindow & { usedPercent: number } =>
        typeof w.usedPercent === "number" && !Number.isNaN(w.usedPercent) && w.usedPercent >= thresholds.quotaPercent,
    );
    if (hot.length > 0) {
      problemKeys.add(problemKey("quotaFull", o.accountId));
      const worst = Math.max(...hot.map((w) => w.usedPercent));
      notifications.push({
        id: problemKey("quotaFull", o.accountId),
        kind: "quotaFull",
        accountId: o.accountId,
        accountName: name,
        title: KIND_LABELS.quotaFull,
        detail:
          hot.map((w) => `${w.window ?? "配额窗口"} ${w.usedPercent.toFixed(0)}%`).join("、") +
          `（阈值 ${thresholds.quotaPercent}%）`,
        at,
        severity: worst >= 100 ? "err" : "warn",
      });
    }
  }

  return { notifications, problemKeys };
}

/**
 * 恢复检测：上一轮存在、本轮消失的问题键 → 「已恢复」通知（绿色、低优先级）。
 * 仅当该账号本轮确实刷新成功（okAccountIds）才生成 —— 账号被删除/禁用时
 * 问题键也会消失，但那不是「恢复」，静默丢弃即可。
 *
 * R14 终审 D-3：可选的 `shouldRecover` 判定用于排除「问题是因为用户关掉提醒开关才消失」
 * 的情况 —— 那不是恢复，不该提示「提醒已解除」。默认（不传）保持原行为，旧调用方不受影响。
 */
export function diffRecovered(
  prevKeys: Iterable<string>,
  curKeys: ReadonlySet<string>,
  okAccountIds: ReadonlySet<string>,
  names: Record<string, string>,
  now: string = new Date().toISOString(),
  shouldRecover: (kind: NotificationKind) => boolean = () => true,
): AppNotification[] {
  const out: AppNotification[] = [];
  for (const key of prevKeys) {
    if (curKeys.has(key)) continue;
    const ref = parseProblemKey(key);
    if (!ref || !okAccountIds.has(ref.accountId)) continue;
    if (!shouldRecover(ref.kind)) continue;
    out.push({
      id: `${RECOVERED_PREFIX}${key}`,
      kind: "recovered",
      accountId: ref.accountId,
      accountName: accountName(names, ref.accountId),
      title: KIND_LABELS.recovered,
      detail: `之前的「${KIND_LABELS[ref.kind]}」提醒已解除`,
      at: now,
      severity: "ok",
    });
  }
  return out;
}

/** 合并恢复通知：按 id 去重（新的覆盖旧的），按时间倒序，限量 max 条防堆积 */
export function mergeRecovered(
  existing: AppNotification[],
  newly: AppNotification[],
  max = 20,
): AppNotification[] {
  const map = new Map<string, AppNotification>();
  for (const n of existing) map.set(n.id, n);
  for (const n of newly) map.set(n.id, n);
  return [...map.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, max);
}

/**
 * 过滤仍有意义的恢复通知：若同一账号同一问题当前再次出现，
 * 对应的「已恢复」即为过期消息，从可见列表剔除。
 */
export function filterActiveRecovered(
  recovered: AppNotification[],
  problemKeys: ReadonlySet<string>,
): AppNotification[] {
  return recovered.filter((n) => !problemKeys.has(n.id.slice(RECOVERED_PREFIX.length)));
}

/* ---------- 已读状态持久化（仅存 {id: true} 映射，通知本体每次刷新重算） ---------- */

/** localStorage 键（lsb- 前缀） */
const READ_KEY = "lsb-notifications";

export type NotificationReadMap = Record<string, boolean>;

export function loadReadMap(): NotificationReadMap {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: NotificationReadMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {}; // 存储不可用 / 数据损坏：全部按未读处理，不阻塞使用
  }
}

export function saveReadMap(map: NotificationReadMap): void {
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用时仅本次会话记住
  }
}

/** 写库前修剪：只保留当前仍存在的通知 id，避免陈旧键长期堆积 */
export function pruneReadMap(map: NotificationReadMap, liveIds: ReadonlySet<string>): NotificationReadMap {
  const out: NotificationReadMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && liveIds.has(k)) out[k] = true;
  }
  return out;
}
