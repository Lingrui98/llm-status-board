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
  const windows = validQuotaWindows(info.quotaWindows);
  const balanceIsZeroOrNull = balance === null || balance.amount === 0;

  if (windows.length > 0 && balanceIsZeroOrNull) {
    const tightest = tightestWindow(info.quotaWindows);
    if (tightest) {
      const usedPercent = clampPercent(tightest.usedPercent);
      const remainingPercent = Number((100 - usedPercent).toFixed(2));
      const remainingText = trimNumberText(remainingPercent);
      const windowLabel = typeof tightest.window === "string" && tightest.window.trim() !== "" ? tightest.window.trim() : DEFAULT_WINDOW_LABEL;
      const resetsText = resetCountdownText(tightest.resetsAt);
      const summary = `${windowLabel} 已用 ${trimNumberText(usedPercent)}%，剩余 ${remainingText}%${
        resetsText ? `（${resetsText}）` : ""
      }`;
      return { kind: "quota", usedPercent, remainingPercent, remainingText, windowLabel, resetsText, summary };
    }
  }

  if (balance !== null) return { kind: "balance", money: balance };
  return { kind: "none" };
}
