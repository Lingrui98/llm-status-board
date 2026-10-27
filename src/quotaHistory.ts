import type { AccountInfo, QuotaBoundary, QuotaHistoryPoint, QuotaSample, QuotaWindow } from "./types";
import { sampleTrendRows, TREND_GAP_MS, type TrendWindow } from "./trendHistory";

export const boundaryLabels: Record<QuotaBoundary, string> = {
  reset: "原重置时间后额度回落", scheduleChanged: "重置时间变更",
  usageDecreased: "额度回落（可能重置或调整）", windowReturned: "窗口恢复记录", expired: "到达原重置时间，等待接口更新",
};

export function quotaKey(window: QuotaWindow): string {
  if (window.historyKey) return window.historyKey;
  if (/^Codex\s*·/.test(window.window ?? "")) {
    if (window.window?.includes("每周")) return "codex:604800";
    if (window.window?.includes("5小时")) return "codex:18000";
  }
  return window.window ?? "unknown";
}

/** Keep review/model-specific allowances separate from the main Codex allowance. */
export function mainSubscriptionWindow(info?: AccountInfo | null): QuotaWindow | null {
  const windows = (info?.quotaWindows ?? []).filter(w =>
    (w.historyKey?.startsWith("codex:") || (!w.historyKey && /^Codex\s*·/.test(w.window ?? ""))) &&
    typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent));
  return windows.find(w => w.windowSeconds === 604800 || quotaKey(w) === "codex:604800") ??
    windows.reduce<QuotaWindow | null>((best, w) => !best || w.usedPercent! > best.usedPercent! ? w : best, null);
}

export function scopedQuotaSamples(samples: readonly QuotaSample[], scope: string): QuotaSample[] {
  return samples.filter(s => s.scope === scope && Number.isFinite(Date.parse(s.ts)))
    .slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export function latestQuotaSegment(samples: readonly QuotaSample[], key: string): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const point = samples[i].windows.find(w => w.key === key);
    if (point) return point.segment;
  }
  return null;
}

export function quotaBounds(samples: readonly QuotaSample[]): [number, number] | null {
  if (!samples.length) return null;
  return [Date.parse(samples[0].ts), Date.parse(samples[samples.length - 1].ts)];
}

export interface QuotaRow {
  timestamp: number;
  value: number | null;
  usedPercent: number;
  point: QuotaHistoryPoint;
  run: number;
}

/** Sample before inserting gaps. Every retained pair is checked for continuity again,
 * so chart downsampling cannot join across a reset or a missing-window interval. */
export function buildQuotaRows(samples: readonly QuotaSample[], key: string, window: TrendWindow,
  metric: "used" | "remaining" = "used", budget = 1000) {
  const raw: QuotaRow[] = [];
  const events: { timestamp: number; boundary: QuotaBoundary }[] = [];
  let previous: QuotaRow | undefined;
  let run = 0;
  for (const sample of samples) {
    const timestamp = Date.parse(sample.ts);
    const point = sample.windows.find(w => w.key === key && Number.isFinite(w.usedPercent) && w.usedPercent >= 0);
    if (!point) { previous = undefined; run++; continue; }
    if (!previous || point.segment !== previous.point.segment || timestamp - previous.timestamp > TREND_GAP_MS) run++;
    const row: QuotaRow = { timestamp, point, run, usedPercent: point.usedPercent,
      value: metric === "used" ? point.usedPercent : Math.max(0, 100 - point.usedPercent) };
    previous = row;
    if (!window.error && timestamp >= window.from && timestamp <= window.to) {
      raw.push(row);
      if (point.boundary) events.push({ timestamp, boundary: point.boundary });
    }
  }
  const sampled = sampleTrendRows(raw, r => [r.value], budget);
  const rows: QuotaRow[] = [];
  for (const row of sampled) {
    const last = rows[rows.length - 1];
    if (last && last.run !== row.run) rows.push({ ...row, timestamp: last.timestamp + (row.timestamp - last.timestamp) / 2, value: null });
    rows.push(row);
  }
  return { rows, count: raw.length, events };
}
