import type { BalanceSnapshot } from "./types";

export type TrendRange = "cycle" | "1h" | "24h" | "7d" | "30d" | "90d" | "all" | "custom";
export interface TrendSelection { preset: TrendRange; from: string; to: string; toNow?: boolean }
export interface TrendWindow { from: number; to: number; error?: string }
export const TREND_RANGES: { value: TrendRange; label: string }[] = [
  { value: "1h", label: "1小时" }, { value: "24h", label: "24小时" },
  { value: "7d", label: "7天" }, { value: "30d", label: "30天" },
  { value: "all", label: "全部" }, { value: "custom", label: "自定义" },
];
const HOUR = 3_600_000;
export const TREND_GAP_MS = 6 * HOUR;

export function historyBounds(snapshots: readonly BalanceSnapshot[]): [number, number] | null {
  let from = Infinity;
  let to = -Infinity;
  for (const s of snapshots) {
    const ts = Date.parse(s.ts);
    if (Number.isFinite(ts)) { from = Math.min(from, ts); to = Math.max(to, ts); }
  }
  return Number.isFinite(from) ? [from, to] : null;
}

export function resolveTrendWindow(selection: TrendSelection, bounds: [number, number] | null, now: number): TrendWindow {
  if (selection.preset === "custom") {
    const from = Date.parse(selection.from);
    const to = selection.toNow ? now : Date.parse(selection.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return { from: 0, to: Number.isFinite(to) ? to : 0, error: selection.toNow ? "请选择有效的开始时间" : "请选择完整的起止时间" };
    if (from >= to) return { from, to, error: selection.toNow ? "开始时间必须早于当前时间" : "开始时间必须早于结束时间" };
    return { from, to };
  }
  if (selection.preset === "all" || selection.preset === "cycle") {
    const [from, to] = bounds ?? [now - 24 * HOUR, now];
    return from === to ? { from: from - 30_000, to: to + 30_000 } : { from, to };
  }
  const duration = { "1h": HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR, "90d": 90 * 24 * HOUR }[selection.preset];
  return { from: now - duration, to: now };
}

export function filterTrendSnapshots(snapshots: readonly BalanceSnapshot[], window: TrendWindow): BalanceSnapshot[] {
  if (window.error) return [];
  return snapshots.filter((s) => {
    const ts = Date.parse(s.ts);
    return Number.isFinite(ts) && ts >= window.from && ts <= window.to;
  });
}

export function localDateTimeInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function trendTick(ts: number, window: TrendWindow): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${window.to - window.from < 300_000 ? `:${pad(d.getSeconds())}` : ""}`;
  return new Date(window.from).toDateString() === new Date(window.to).toDateString()
    ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** 显式共用刻度，避免图表库按各自点数生成不同刻度。 */
export function trendTicks(window: TrendWindow): number[] {
  if (window.error || window.to <= window.from) return [];
  const steps = [1000, 5000, 15_000, 30_000, 60_000, 300_000, 600_000, 900_000, 1_800_000,
    HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 2 * 24 * HOUR, 7 * 24 * HOUR, 10 * 24 * HOUR,
    14 * 24 * HOUR, 21 * 24 * HOUR, 30 * 24 * HOUR];
  const target = (window.to - window.from) / 4;
  const step = steps.find((s) => s >= target) ?? Math.ceil(target / (30 * 24 * HOUR)) * 30 * 24 * HOUR;
  const ticks: number[] = [];
  for (let ts = Math.ceil(window.from / step) * step; ts <= window.to; ts += step) ticks.push(ts);
  return ticks.length >= 2 ? ticks : [window.from, window.to];
}

/** 只减少绘制点，保留实际采样值、首末点、各序列极值及断线标记；不修改原始历史。 */
export function sampleTrendRows<T>(rows: readonly T[], values: (row: T) => readonly (number | null | undefined)[], budget = 1600): T[] {
  if (rows.length <= budget) return rows.slice();
  const dimensions = values(rows[0]).length;
  const buckets = Math.max(1, Math.floor(budget / (2 + 2 * dimensions)));
  const size = Math.ceil(rows.length / buckets);
  const keep = new Set<number>([0, rows.length - 1]);
  for (let start = 0; start < rows.length; start += size) {
    const end = Math.min(start + size, rows.length);
    keep.add(start); keep.add(end - 1);
    const mins = new Array(dimensions).fill(Infinity);
    const maxs = new Array(dimensions).fill(-Infinity);
    const minAt = new Array(dimensions).fill(-1);
    const maxAt = new Array(dimensions).fill(-1);
    for (let i = start; i < end; i++) {
      const amounts = values(rows[i]);
      if (amounts.every((v) => v == null || !Number.isFinite(v))) {
        keep.add(i);
        if (i > 0) keep.add(i - 1);
        if (i + 1 < rows.length) keep.add(i + 1);
      }
      amounts.forEach((v, dim) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        if (v < mins[dim]) { mins[dim] = v; minAt[dim] = i; }
        if (v > maxs[dim]) { maxs[dim] = v; maxAt[dim] = i; }
      });
    }
    for (const i of [...minAt, ...maxAt]) if (i >= 0) keep.add(i);
  }
  return [...keep].sort((a, b) => a - b).map((i) => rows[i]);
}
