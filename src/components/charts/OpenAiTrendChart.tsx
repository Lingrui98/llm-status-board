import { useMemo } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OpenAiUsageReport } from "../../types";
import { formatCompact, formatMoney, formatNumber } from "../../format";
import { trendTicks } from "../../trendHistory";
import DrawerSection from "../DrawerSection";

const TITLES = {
  cost: "每日花费",
  monthToDate: "月内累计花费",
  tokens: "Token 趋势",
  requests: "请求数趋势",
} as const;
type Metric = keyof typeof TITLES;
type Day = OpenAiUsageReport["days"][number];
type Field = keyof Omit<Day, "date">;
const TOKEN_SERIES = [
  { field: "inputTokens", name: "输入", stroke: "var(--accent)" },
  { field: "outputTokens", name: "输出", stroke: "var(--ok)" },
  { field: "cachedInputTokens", name: "缓存命中（已含在输入）", stroke: "var(--warn)" },
  { field: "cacheWriteTokens", name: "写入缓存（已含在输入）", stroke: "var(--text-3)" },
] as const;

export default function OpenAiTrendChart({ days, metric, currency }: { days: Day[]; metric: Metric; currency: string | null }) {
  const rows = useMemo(() => {
    const points = days.map((day) => ({ ...day, timestamp: Date.parse(`${day.date}T00:00:00Z`) }));
    if (metric !== "monthToDate") return points;
    return points.flatMap((point, index) => {
      const previous = points[index - 1];
      return previous && previous.date.slice(0, 7) !== point.date.slice(0, 7)
        ? [{ ...point, timestamp: (point.timestamp + previous.timestamp) / 2, monthToDate: null }, point] : [point];
    });
  }, [days, metric]);
  const title = TITLES[metric];
  const candidates: { field: Field; name: string; stroke: string }[] = metric === "tokens"
    ? [...TOKEN_SERIES]
    : [{ field: metric, name: title, stroke: "var(--accent)" }];
  const series = candidates.filter(({ field }) => days.some((day) => Number.isFinite(day[field])));
  const hasData = series.length > 0;
  const from = rows[0]?.timestamp ?? 0;
  const to = rows[rows.length - 1]?.timestamp ?? from;

  return <DrawerSection key={String(hasData)} title={currency ? `${title} · ${currency}` : title} hasData={hasData} emptyNote="所选范围暂无记录">
    {hasData && <ResponsiveContainer width="100%" minWidth={0} height={195} className="chart-box">
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="timestamp" type="number" scale="time" domain={from === to ? [from - 43_200_000, to + 43_200_000] : [from, to]}
          ticks={from === to ? [from] : trendTicks({ from, to })} tickFormatter={(ts: number) => new Date(ts).toISOString().slice(5, 10)}
          tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "currentColor" }} minTickGap={22} />
        <YAxis width={54} domain={["auto", "auto"]} tickLine={false} axisLine={false}
          tick={{ fontSize: 11, fill: "currentColor" }} tickFormatter={(value: number) => formatCompact(value)} />
        <Tooltip labelFormatter={(value) => `${new Date(Number(value)).toISOString().slice(0, 10)} UTC`}
          formatter={(value) => typeof value === "number"
            ? (currency ? formatMoney({ amount: value, currency }) : formatNumber(value)) : "—"}
          cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 3" }}
          contentStyle={{ background: "var(--bg-2)", borderColor: "var(--border)", color: "var(--text)", borderRadius: 8 }} />
        {metric === "tokens" && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {series.map(({ field, name, stroke }) => <Line key={field} dataKey={field} name={name} stroke={stroke} strokeWidth={2}
          dot={{ r: 2, strokeWidth: 0, fill: stroke }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>}
  </DrawerSection>;
}
