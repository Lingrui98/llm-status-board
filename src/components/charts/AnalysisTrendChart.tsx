import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCompact, formatDecimal } from "../../format";
import { ChartEmpty, dayLabel, usePrefersReducedMotion } from "./shared";

export interface AnalysisTrendPoint {
  /** 本地日历日 "YYYY-MM-DD" */
  date: string;
  value: number;
}

interface Props {
  /** 旧→新的逐日数值（缺失日由调用方补 0，保证 x 轴连续） */
  points: AnalysisTrendPoint[];
  /** 数值单位（如 "USD"），用于 tooltip */
  unit?: string;
  /** 图例/标题用的口径说明（如「近 14 天花费」） */
  label?: string;
  /** 空数据时的具体原因说明 */
  emptyNote?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function TrendTip({ active, payload, unit, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload as AnalysisTrendPoint | undefined;
  if (!p) return null;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{p.date}</div>
      <div className="tt-row">
        <span>{label ?? "数值"}</span>
        <b>{`${formatDecimal(p.value)}${unit ? ` ${unit}` : ""}`}</b>
      </div>
    </div>
  );
}

/**
 * 分析视图的逐日趋势图（R15）。**必须经 charts/lazy.tsx 懒加载**，
 * 否则 recharts 会被拉回首屏主包（R11 已把主包压到 ~218KB）。
 */
export default function AnalysisTrendChart({ points, unit, label, emptyNote }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const rows = useMemo(() => (points ?? []).filter((p) => !!p && Number.isFinite(p.value)), [points]);

  if (rows.length === 0) return <ChartEmpty text={emptyNote} />;

  const peak = Math.max(...rows.map((r) => r.value), 0);
  const height = 168;

  return (
    <ResponsiveContainer width="100%" height={height} className="chart-box">
      <AreaChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="analysis-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10, fill: "currentColor" }}
          tickFormatter={(s: string) => dayLabel(s)}
          minTickGap={12}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={46}
          domain={[0, peak > 0 ? peak * 1.15 : 1]}
          tick={{ fontSize: 10, fill: "currentColor" }}
          tickFormatter={(v: number) => formatCompact(v)}
        />
        <Tooltip content={<TrendTip unit={unit} label={label} />} cursor={{ stroke: "var(--chart-cursor-fill)" }} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--accent)"
          strokeWidth={2}
          fill="url(#analysis-trend-fill)"
          isAnimationActive={!reducedMotion}
          animationDuration={500}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
