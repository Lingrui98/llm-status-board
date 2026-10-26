import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { QuotaSample } from "../../types";
import { boundaryLabels, buildQuotaRows, type QuotaRow } from "../../quotaHistory";
import { trendTick, trendTicks, type TrendWindow } from "../../trendHistory";
import { trimNumberText } from "../../primaryMetric";
import { ChartEmpty } from "./shared";

function QuotaTip({ active, payload }: { active?: boolean; payload?: { payload: QuotaRow }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.value == null) return null;
  return <div className="chart-tooltip">
    <div className="tt-title">{new Date(row.timestamp).toLocaleString("zh-CN", { hour12: false })}</div>
    <div className="tt-row"><span>{row.point.label}</span><b>已用 {trimNumberText(row.usedPercent)}% · 剩余 {trimNumberText(Math.max(0, 100 - row.usedPercent))}%</b></div>
    {row.point.resetsAt && <div>接口重置时间：{new Date(row.point.resetsAt).toLocaleString("zh-CN", { hour12: false })}</div>}
    {row.point.boundary && <div>{boundaryLabels[row.point.boundary]}</div>}
  </div>;
}

export default function QuotaHistoryChart({ samples, windowKey, window, metric = "used" }: {
  samples: QuotaSample[]; windowKey: string; window: TrendWindow; metric?: "used" | "remaining";
}) {
  const { rows, count, events } = useMemo(() => buildQuotaRows(samples, windowKey, window, metric), [samples, windowKey, window, metric]);
  if (count < 2) return <ChartEmpty text={window.error ?? (count === 1 ? "已有 1 个采样，再成功刷新一次即可形成趋势" : "此范围暂无额度记录")} />;
  const maximum = Math.max(100, ...rows.map(r => r.value ?? 0));
  return <div>
    <div className="trend-unit">{metric === "used" ? "已用" : "剩余"} %</div>
    <ResponsiveContainer width="100%" height={230} className="chart-box">
      <LineChart data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="timestamp" type="number" scale="time" domain={[window.from, window.to]} allowDataOverflow
          ticks={trendTicks(window)} tickFormatter={(ts: number) => trendTick(ts, window)}
          tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "currentColor" }} minTickGap={24} />
        <YAxis domain={[0, maximum]} width={48} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false}
          tick={{ fontSize: 11, fill: "currentColor" }} />
        <Tooltip content={<QuotaTip />} cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 3" }} />
        {events.slice(-30).map((event, index) => <ReferenceLine key={`${event.timestamp}-${index}`} x={event.timestamp}
          stroke="var(--text-3)" strokeDasharray="3 3" />)}
        <Line type="stepAfter" dataKey="value" stroke="var(--accent)" strokeWidth={2} connectNulls={false}
          dot={({ cx, cy, index, payload }: { cx?: number; cy?: number; index?: number; payload?: QuotaRow }) => {
            if (cx == null || cy == null || index == null || payload?.value == null) return <g />;
            const isolated = [rows[index - 1], rows[index + 1]].every(row => !row || row.value == null);
            return rows.length < 100 || isolated ? <circle cx={cx} cy={cy} r={2} fill="var(--accent)" /> : <g />;
          }}
          activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
