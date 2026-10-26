// R19 卡片主指标规则（通用纯函数，不打供应商补丁）。
// 规格：docs/round-19-plan.md §1/§2
//   1. info == null → none
//   2. 有效窗口 ≥1 且（余额为 null 或 amount === 0）→ quota：订阅剩余百分比
//      （取最紧窗口 = usedPercent 最大者；剩余 = 100 − clamp(used,0,100)）
//   3. 其余且有余额 → balance（含「无窗口 + 余额 0」：$0.00 是真实信息）
//   4. 余额 null 且无有效窗口 → none
// 剩余展示：整数不带小数、需要时最多 2 位（去尾 0），与规格笔算一致（ModelServer 100、Kimi 73.14）。

import { formatTimeUntil } from "./format";
import type { AccountInfo, Money, QuotaWindow } from "./types";
import { mainSubscriptionWindow } from "./quotaHistory";

export type PrimaryMetric =
  | { kind: "none" }
  | { kind: "balance"; money: Money | null }
  | {
      kind: "quota";
      /** 钳制后的最紧窗口已用百分比（0–100） */
      usedPercent: number;
      /** 剩余百分比（0–100，最多 2 位小数） */
      remainingPercent: number;
      /** 展示用剩余文本（整数不带小数、去尾 0） */
      remainingText: string;
      /** 窗口名；缺失 → 「当前窗口」 */
      windowLabel: string;
      /** 重置倒计时文案；resetsAt 缺失 → null */
      resetsText: string | null;
      /** 读屏摘要 */
      summary: string;
    };

/** 窗口名缺失/空白时的兜底文案（规格 §1.5） */
export const DEFAULT_WINDOW_LABEL = "当前窗口";

/** 窗口名解析（R23 提取为共享出口）：缺失/空白 → 「当前窗口」；前后端同一规则 */
export function windowLabel(w?: Pick<QuotaWindow, "window"> | null): string {
  const raw = typeof w?.window === "string" ? w.window.trim() : "";
  return raw !== "" ? raw : DEFAULT_WINDOW_LABEL;
}

/** 无数据（info 为 null，或余额 null 且无有效窗口）的规范串（R20 §1） */
export const NO_DATA_TEXT = "—";

/** 失败态前缀（R20 §1：优先级最高，独立于 info 层） */
export const FAILURE_LINE_PREFIX = "✗";

/** 失败原因截断：12 字符规则 = 取 11 字符 + 「…」（与托盘现状一致，R20 §1） */
export const FAILURE_REASON_MAX_CHARS = 12;

/** 失败原因缺失时的兜底文案（规格未定义；保持可读且短） */
export const FAILURE_REASON_FALLBACK = "刷新失败";

/** 钳制到 [0,100] */
export function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** 去尾 0 的数字文本（最多 2 位小数）：100 → "100"、73.14 → "73.14"、73.1 → "73.1" */
export function trimNumberText(value: number, maxDigits = 2): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(maxDigits)));
}

/**
 * 有效窗口：usedPercent 为有限数字者（null/NaN/undefined 一律忽略，规格 §1.5）。
 * window 名不放宽，仅做展示兜底。
 */
export function validQuotaWindows(windows?: readonly QuotaWindow[] | null): (QuotaWindow & { usedPercent: number })[] {
  if (!windows || windows.length === 0) return [];
  return windows.filter(
    (w): w is QuotaWindow & { usedPercent: number } =>
      !!w && typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent),
  );
}

/** 最紧窗口 = usedPercent 最大者（钳制后再比较；同值取先出现者，稳定） */
export function tightestWindow(windows?: readonly QuotaWindow[] | null): (QuotaWindow & { usedPercent: number }) | null {
  const list = validQuotaWindows(windows);
  if (list.length === 0) return null;
  let best = list[0];
  let bestPct = clampPercent(best.usedPercent);
  for (const w of list.slice(1)) {
    const pct = clampPercent(w.usedPercent);
    if (pct > bestPct) {
      best = w;
      bestPct = pct;
    }
  }
  return best;
}

/** 重置倒计时：缺失 → null；已过期 → 「已到期」；否则「N 分钟/小时/天后重置」 */
export function resetCountdownText(resetsAt?: string | null): string | null {
  if (!resetsAt) return null;
  const until = formatTimeUntil(resetsAt);
  if (until === "—" || until === "") return null;
  return until === "已到期" ? until : `${until}重置`;
}

/** raw 里的钱包充值额度（balance_credits，兼容字符串数字）；非正数/缺失 → null */
export function readBalanceCredits(raw?: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const v = obj.balance_credits ?? obj.balanceCredits;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * 主指标判定（规格 §1 判定顺序）。
 * 越界钳制：usedPercent < 0 → 100% 剩余；> 100 → 0% 剩余（不展示原始越界值）。
 */
export function pickPrimaryMetric(info?: AccountInfo | null): PrimaryMetric {
  if (!info) return { kind: "none" };

  const balance = info.balance ?? null;
  const subscription = !!info.quotaScope || info.quotaWindows?.some(w => /^(codex|review|extra):/.test(w.historyKey ?? ""));
  const main = subscription ? mainSubscriptionWindow(info) : null;
  const sourceWindows = subscription ? (main ? [main] : []) : info.quotaWindows;
  const windows = validQuotaWindows(sourceWindows);
  const balanceIsZeroOrNull = balance === null || balance.amount === 0;

  if (windows.length > 0 && balanceIsZeroOrNull) {
    const tightest = tightestWindow(sourceWindows);
    if (tightest) {
      const usedPercent = clampPercent(tightest.usedPercent);
      const remainingPercent = Number((100 - usedPercent).toFixed(2));
      const remainingText = trimNumberText(remainingPercent);
      const windowLabelText = windowLabel(tightest);
      const resetsText = resetCountdownText(tightest.resetsAt);
      const summary = `${windowLabelText} 已用 ${trimNumberText(usedPercent)}%，剩余 ${remainingText}%${
        resetsText ? `（${resetsText}）` : ""
      }`;
      return { kind: "quota", usedPercent, remainingPercent, remainingText, windowLabel: windowLabelText, resetsText, summary };
    }
  }

  if (balance !== null) return { kind: "balance", money: balance };
  return { kind: "none" };
}

/* ============================ R20：单行规范串（唯一出口） ============================ */

/* ---- R23：限额窗口明细（浮层/菜单共用口径；与 Rust tray.rs window_detail_line 同源） ---- */

/** 限额窗口明细显示方式（设置项 quotaDetailDisplay；缺省 percent） */
export type QuotaDetailDisplay = "percent" | "raw";

/** 配额已用百分比 → 语义色级（与 QuotaWindowBars 既有阈值一致：>80 红 / 60–80 琥珀 / 其余绿） */
export function quotaLevel(usedPercent: number): "ok" | "warn" | "err" {
  if (usedPercent > 80) return "err";
  if (usedPercent >= 60) return "warn";
  return "ok";
}

/**
 * 窗口用量文本（不含窗口名与重置倒计时；纯函数）：
 * - percent：`已用 {N}%`——N 为**真实值**（超限可 >100；钳制只作用于图形宽度，不吃事实）；
 * - raw 且窗口带金额字段：`已用 {A} / 上限 {L} {币种}`；
 * - raw 但无金额字段（如 Kimi 的纯百分比窗口）→ 诚实回落 percent，不留空白。
 */
export function windowUsageText(
  w: QuotaWindow & { usedPercent: number },
  mode: QuotaDetailDisplay,
): string {
  if (mode === "raw" && w.usedAmount && w.limitAmount) {
    return `已用 ${formatMoneyAmountPlain(w.usedAmount.amount)} / 上限 ${formatMoneyAmountPlain(w.limitAmount.amount)} ${w.usedAmount.currency}`;
  }
  return `已用 ${trimNumberText(w.usedPercent)}%`;
}

/**
 * 金额小数位（R20 §1，与 Rust format_decimal 规则逐字对齐）：
 * |v| ≥ 1 → 2 位；0.01 ≤ |v| < 1 → 4 位；0 < |v| < 0.01 → 6 位；0 → 2 位（`0.00`）。
 * 刻意**不用** toLocaleString：避免千分位分隔符破坏跨语言逐字一致。
 */
export function formatMoneyAmountPlain(value: number | null | undefined): string {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const abs = Math.abs(v);
  let digits = 2;
  if (abs > 0 && abs < 0.01) digits = 6;
  else if (abs > 0 && abs < 1) digits = 4;
  return v.toFixed(digits);
}

/**
 * 失败原因截断（12 字符规则，按 Unicode 码点计数以对齐 Rust `chars().take(11)`）。
 * 对齐 Rust `tray.rs`：`error.unwrap_or("刷新失败").trim()` 后空判 —— 因此**先去首尾空白**，
 * 空白串与缺失一律回落 `FAILURE_REASON_FALLBACK`（R20 §3 附注，已与 PM/Rust 双侧核对）。
 */
export function truncateFailureReason(reason?: string | null): string {
  const raw = (typeof reason === "string" ? reason : "").trim();
  const chars = Array.from(raw);
  if (chars.length === 0) return FAILURE_REASON_FALLBACK;
  if (chars.length <= FAILURE_REASON_MAX_CHARS) return raw;
  return `${chars.slice(0, FAILURE_REASON_MAX_CHARS - 1).join("")}…`;
}

/** 失败态规范串：`✗ {原因}`（原因 12 字符截断；缺失 → `刷新失败`） */
export function formatFailureLine(reason?: string | null): string {
  return `${FAILURE_LINE_PREFIX} ${truncateFailureReason(reason)}`;
}

/**
 * 主指标规范串（R20 §1/§2，浮层与托盘逐字一致）：
 * - quota   → `剩余 {剩余}%（{窗口名}）`
 * - balance → `{金额} {币种}`（金额小数位见 formatMoneyAmountPlain）
 * - none    → `—`
 * 失败态**不在**本函数（它属于结果层，见 formatFailureLine），调用方按
 * 「失败 → 订阅/余额 → 无数据」的优先级组合。
 */
export function formatPrimaryMetricLine(metric: PrimaryMetric): string {
  if (metric.kind === "quota") {
    return `剩余 ${metric.remainingText}%（${metric.windowLabel}）`;
  }
  if (metric.kind === "balance") {
    const money = metric.money;
    if (!money || !Number.isFinite(money.amount)) return NO_DATA_TEXT;
    return `${formatMoneyAmountPlain(money.amount)} ${money.currency}`;
  }
  return NO_DATA_TEXT;
}
