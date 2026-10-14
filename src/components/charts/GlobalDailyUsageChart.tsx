import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountConfig, RefreshOutcome, UsagePoint } from "../../types";
import { formatCompact, formatNumber } from "../../format";
import { ChartEmpty, dayLabel } from "./shared";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
}

/** 多账号配色（堆叠面积 / 折线共用，按排名取色） */
export const SERIES_COLORS = [
  "#4da3ff",
  "#3ecf8e",
  "#f0b44c",
  "#b48bff",
  "#ff8fb0",
  "#4dd0e1",
  "#8d99ae",
];

const MAX_SERIES = 6;
const OTHER_KEY = "__other__";

interface SeriesDef {
  key: string; // accountId 或 OTHER_KEY（用作 dataKey，保证唯一）
  name: string; // 图例 / tooltip 显示名
  color: string;
}

type Row = { date: string } & { [key: string]: number | string };

interface TipProps {
  active?: boolean;
  label?: string;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number | string; color?: string }>;
  series: SeriesDef[];
}

function GlobalDailyTip({ active, payload, label, series }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const nameOf = (k: string | number | undefined) =>
    series.find((s) => s.key === k)?.name ?? String(k ?? "");
  const total = payload.reduce((acc, p) => acc + (typeof p.value === "number" ? p.value : 0), 0);
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{label}</div>
      {[...payload].reverse().map((p) => (
        <div className="tt-row" key={String(p.dataKey)}>
          <span>
            <i className="tt-swatch" style={{ background: p.color }} />
            {nameOf(p.dataKey)}
          </span>
          <b>{formatNumber(typeof p.value === "number" ? p.value : null)}</b>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="tt-row tt-total">
          <span>合计</span>
          <b>{formatNumber(total)}</b>
        </div>
      )}
    </div>
  );
}

/**
 * 全账号请求趋势（近 14 天）：合并各账号 dailyUsage，按 date 对齐。
 * 多账号 → 按账号分色的堆叠面积图（按请求总量取前 6，其余合并为「其他」）；
 * 单账号 → 退化为普通面积图。
 */
export default function GlobalDailyUsageChart({ accounts, statuses }: Props) {
  const gid = useId().replace(/:/g, "");
  const { rows, series } = useMemo(() => {
    // 收集每个账号的 dailyUsage（date → requests 求和）
    const perAccount: { id: string; name: string; total: number; byDate: Map<string, number> }[] = [];
    for (const acc of accounts) {
      const pts = (statuses[acc.id]?.info?.dailyUsage ?? []).filter(
        (p): p is UsagePoint & { date: string } => !!p && !!p.date && p.requests !== null && p.requests !== undefined,
      );
      if (pts.length === 0) continue;
      const byDate = new Map<string, number>();
      let total = 0;
      for (const p of pts) {
        const req = p.requests ?? 0;
        byDate.set(String(p.date), (byDate.get(String(p.date)) ?? 0) + req);
        total += req;
      }
      perAccount.push({ id: acc.id, name: acc.name || acc.id, total, byDate });
    }
    if (perAccount.length === 0) return { rows: [] as Row[], series: [] as SeriesDef[] };

    // 近 14 天：取所有账号出现过的日期，排序后截尾部 14 天
    const allDates = [...new Set(perAccount.flatMap((a) => [...a.byDate.keys()]))]
      .sort((a, b) => a.localeCompare(b))
      .slice(-14);

    // 按请求总量排名，前 6 独立成列，其余并入「其他」
    const ranked = [...perAccount].sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, MAX_SERIES);
    const rest = ranked.slice(MAX_SERIES);
    const series: SeriesDef[] = top.map((a, i) => ({
      key: a.id,
      name: a.name,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));
    if (rest.length > 0) {
      series.push({ key: OTHER_KEY, name: "其他", color: SERIES_COLORS[MAX_SERIES % SERIES_COLORS.length] });
    }

    const rows: Row[] = allDates.map((d) => {
      const row: Row = { date: dayLabel(d) };
      for (const a of top) row[a.id] = a.byDate.get(d) ?? 0;
      if (rest.length > 0) row[OTHER_KEY] = rest.reduce((acc, a) => acc + (a.byDate.get(d) ?? 0), 0);
      return row;
    });
    return { rows, series };
  }, [accounts, statuses]);

  if (rows.length < 2 || series.length === 0) return <ChartEmpty text="暂无用量数据" />;

  const stacked = series.length > 1;

  return (
    <ResponsiveContainer width="100%" height={220} className="chart-box">
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`gd-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={stacked ? 0.42 : 0.32} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(127,147,175,0.14)" vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          dy={6}
          tick={{ fontSize: 11, fill: "currentColor" }}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={(v: number) => formatCompact(v)}
        />
        <Tooltip
          content={<GlobalDailyTip series={series} />}
          cursor={{ stroke: "rgba(127,147,175,0.35)", strokeDasharray: "3 3" }}
        />
        {stacked && (
          <Legend
            iconType="circle"
            iconSize={7}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          />
        )}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stackId={stacked ? "req" : undefined}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#gd-${gid}-${s.key})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
