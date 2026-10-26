import { useId, useMemo, useState } from "react";
import type { BalanceSnapshot } from "../types";
import { filterTrendSnapshots, historyBounds, localDateTimeInput, resolveTrendWindow, TREND_RANGES } from "../trendHistory";
import type { TrendSelection, TrendWindow } from "../trendHistory";

export function useTrendRange(snapshots: BalanceSnapshot[], now = Date.now()) {
  const [selection, setSelection] = useState<TrendSelection>({ preset: "all", from: "", to: "" });
  const bounds = useMemo(() => historyBounds(snapshots), [snapshots]);
  const window = useMemo(() => resolveTrendWindow(selection, bounds, now), [selection, bounds, now]);
  const filtered = useMemo(() => filterTrendSnapshots(snapshots, window), [snapshots, window]);
  return { selection, setSelection, bounds, window, filtered };
}

interface Props {
  selection: TrendSelection;
  onChange: (selection: TrendSelection) => void;
  bounds: [number, number] | null;
  window: TrendWindow;
  ranges?: readonly { value: TrendSelection["preset"]; label: string }[];
}

export default function TrendRangeControls({ selection, onChange, bounds, window, ranges = TREND_RANGES }: Props) {
  const id = useId();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fullTime = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });
  return (
    <div className="trend-controls">
      <div className="trend-range-buttons" role="group" aria-label="趋势时间范围">
        {ranges.map(({ value, label }) => (
          <button key={value} type="button" aria-pressed={selection.preset === value}
            onClick={() => {
              const [from, to] = bounds ?? [Date.now() - 86_400_000, Date.now()];
              onChange({ ...selection, preset: value,
                from: selection.from || localDateTimeInput(from),
                to: selection.to || localDateTimeInput(to === from ? to + 60_000 : to) });
            }}>{label}</button>
        ))}
      </div>
      {selection.preset === "custom" && (
        <div className="trend-custom-range">
          <label>开始时间<input type="datetime-local" step="1" value={selection.from}
            aria-invalid={!!window.error} aria-describedby={window.error ? id : undefined}
            onChange={(e) => onChange({ ...selection, from: e.target.value })} /></label>
          <label>结束时间<input type="datetime-local" step="1" value={selection.to}
            aria-invalid={!!window.error} aria-describedby={window.error ? id : undefined}
            onChange={(e) => onChange({ ...selection, to: e.target.value })} /></label>
        </div>
      )}
      {window.error && <p id={id} className="trend-range-error" role="status">{window.error}</p>}
      <p className="trend-history-note">本地时间（{timezone}） · {bounds
        ? `已有记录：${fullTime(bounds[0])} — ${fullTime(bounds[1])}` : "暂无本地记录"}</p>
    </div>
  );
}
