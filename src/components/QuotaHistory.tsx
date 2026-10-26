import { useMemo, useState } from "react";
import type { AccountInfo, QuotaSample } from "../types";
import { boundaryLabels, buildQuotaRows, latestQuotaSegment, mainSubscriptionWindow, quotaBounds, quotaKey, scopedQuotaSamples } from "../quotaHistory";
import { resolveTrendWindow, type TrendSelection } from "../trendHistory";
import TrendRangeControls from "./TrendRangeControls";
import { LazyQuotaHistoryChart } from "./charts/lazy";

const ranges = [
  { value: "cycle", label: "本周期" }, { value: "24h", label: "24小时" }, { value: "7d", label: "7天" },
  { value: "30d", label: "30天" }, { value: "90d", label: "90天" }, { value: "all", label: "全部" }, { value: "custom", label: "自定义" },
] as const;

function currentSegment(samples: QuotaSample[], key: string): QuotaSample[] {
  const segment = latestQuotaSegment(samples, key);
  const start = samples.find(s => s.windows.some(w => w.key === key && w.segment === segment));
  return start ? samples.filter(s => Date.parse(s.ts) >= Date.parse(start.ts)) : [];
}

export function QuotaMini({ samples, info, error, now = Date.now() }: { samples: QuotaSample[]; info: AccountInfo | null; error?: string | null; now?: number }) {
  const main = mainSubscriptionWindow(info);
  const key = main ? quotaKey(main) : "";
  const data = useMemo(() => currentSegment(scopedQuotaSamples(samples, info?.quotaScope ?? ""), key), [samples, info?.quotaScope, key]);
  const bounds = quotaBounds(data);
  const window = resolveTrendWindow({ preset: "all", from: "", to: "" }, bounds, now);
  const { rows, count } = buildQuotaRows(data, key, window, "used", 120);
  let path = "", previousRun = -1;
  for (const row of rows) {
    if (row.value == null) { previousRun = -1; continue; }
    const x = 4 + (row.timestamp - window.from) / (window.to - window.from || 1) * 252;
    const y = 52 - Math.min(100, Math.max(0, row.value)) / 100 * 46;
    path += row.run === previousRun ? `H${x.toFixed(2)}V${y.toFixed(2)}` : `M${x.toFixed(2)},${y.toFixed(2)}`;
    previousRun = row.run;
  }
  return <div className="quota-mini">
    <span className="muted small">{main?.window ?? "订阅额度"} · 本周期已用趋势</span>
    {count >= 2 ? <svg viewBox="0 0 260 58" preserveAspectRatio="none" role="img" aria-label="当前额度周期已用百分比趋势">
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {rows.filter(row => row.value != null).map((row, i) => <circle key={`${row.timestamp}-${i}`}
        cx={4 + (row.timestamp - window.from) / (window.to - window.from || 1) * 252}
        cy={52 - Math.min(100, Math.max(0, row.value!)) / 100 * 46} r={1.5} fill="var(--accent)" />)}
    </svg> : <p className="muted small">{count === 1 ? "已记录 1 次，再刷新后显示曲线" : "成功刷新后开始记录额度历史"}</p>}
    {(error || info?.quotaHistoryError) && <p className="quota-history-error" role="status">{error || info?.quotaHistoryError}</p>}
  </div>;
}

export default function QuotaHistory({ samples, info, error, now = Date.now() }: { samples: QuotaSample[]; info: AccountInfo | null; error?: string | null; now?: number }) {
  const scoped = useMemo(() => scopedQuotaSamples(samples, info?.quotaScope ?? ""), [samples, info?.quotaScope]);
  const options = useMemo(() => {
    const map = new Map<string, string>();
    for (const sample of scoped) for (const w of sample.windows) map.set(w.key, w.label);
    for (const w of info?.quotaWindows ?? []) map.set(quotaKey(w), w.window ?? "额度窗口");
    return [...map];
  }, [scoped, info?.quotaWindows]);
  const preferred = mainSubscriptionWindow(info);
  const [selected, setSelected] = useState("");
  const key = options.some(([k]) => k === selected) ? selected : preferred ? quotaKey(preferred) : options[0]?.[0] ?? "";
  const [selection, setSelection] = useState<TrendSelection>({ preset: "cycle", from: "", to: "" });
  const [metric, setMetric] = useState<"used" | "remaining">("used");
  const source = useMemo(() => selection.preset === "cycle" ? currentSegment(scoped, key) : scoped, [scoped, key, selection.preset]);
  const window = resolveTrendWindow(selection, quotaBounds(source), now);
  const { events, count } = useMemo(() => buildQuotaRows(source, key, window, metric), [source, key, window.from, window.to, window.error, metric]);
  return <section className="quota-history">
    <h3>额度使用历史</h3>
    <div className="quota-history-selectors">
      <label>额度窗口<select value={key} onChange={e => setSelected(e.target.value)}>
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>展示口径<select value={metric} onChange={e => setMetric(e.target.value as "used" | "remaining")}>
        <option value="used">已用百分比</option><option value="remaining">剩余百分比</option>
      </select></label>
    </div>
    <TrendRangeControls selection={selection} onChange={setSelection} bounds={quotaBounds(scoped)} window={window} ranges={ranges} />
    {(error || info?.quotaHistoryError) && <p className="quota-history-error" role="status">{error || info?.quotaHistoryError}</p>}
    {!info?.quotaScope && <p className="muted">登录并成功刷新后开始记录；已有登录需刷新一次以识别工作区。</p>}
    <LazyQuotaHistoryChart samples={source} windowKey={key} window={window} metric={metric} />
    <p className="trend-history-note">本周期按观测到的重置或调整分段，周期长度不固定。虚线是首次观测到变化的时间，实际重置可能更早。</p>
    {events.length > 0 && <ul className="quota-history-events">{events.slice(-5).map((event, i) => <li key={`${event.timestamp}-${i}`}>
      {new Date(event.timestamp).toLocaleString("zh-CN", { hour12: false })} · {boundaryLabels[event.boundary]}
    </li>)}</ul>}
    <p className="trend-history-note">当前范围 {count.toLocaleString("zh-CN")} 个采样。按账号保留 90 天、最多 15 万次采样；绘图抽样。离线期间无法恢复重置次数，不补算费用或消息数。</p>
  </section>;
}
