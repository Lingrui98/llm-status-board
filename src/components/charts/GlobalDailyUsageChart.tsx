import { useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountConfig, RefreshOutcome } from "../../types";
import { formatCompact, formatDecimal, formatNumber } from "../../format";
import { ChartEmpty, dayLabel, usePrefersReducedMotion } from "./shared";
import { normalizeLocalDay } from "../../localDay";
import { dateRange, inRange, shiftDateKey } from "../../analysis";
import { dashboardCurrency } from "../../dashboardData";
import { toLocalDateKey } from "../../usageHistory";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
  /** 展示最近 7 / 14 / 30 个日历日，默认 14 */
  days?: number;
  now?: number;
}

/** 多账号配色（面积 / 折线共用，按排名取色）：引用 CSS 变量，随暗/亮主题切换 */
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

const MAX_SERIES = 6;
const OTHER_KEY = "__other__";

type Metric = "requests" | "cost";

interface SeriesDef {
  key: string; // accountId 或 OTHER_KEY（用作 dataKey，保证唯一）
  name: string; // 图例 / tooltip 显示名
  color: string;
}

type Row = { date: string } & { [key: string]: number | string | null };

interface AccountSeries {
  id: string;
  name: string;
  values: Map<string, number>;
  total: number;
}

interface TipProps {
  active?: boolean;
  label?: string;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number | string | null; color?: string }>;
  series: SeriesDef[];
  metric: Metric;
  unit: string;
}

export function GlobalDailyTip({ active, payload, label, series, metric, unit }: TipProps) {
  const points = payload?.filter((p): p is typeof p & { value: number } => typeof p.value === "number");
  if (!active || !points?.length) return null;
  const nameOf = (k: string | number | undefined) =>
    series.find((s) => s.key === k)?.name ?? String(k ?? "");
  const fmt = (v: number) =>
    metric === "cost" ? `${formatDecimal(v)} ${unit === "UNKNOWN" ? "" : unit}`.trim() : formatNumber(v);
  const total = points.reduce((acc, p) => acc + p.value, 0);
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{label ? dayLabel(label) : ""}</div>
      {[...points].reverse().map((p) => (
        <div className="tt-row" key={String(p.dataKey)}>
          <span>
            <i className="tt-swatch" style={{ background: p.color }} />
            {nameOf(p.dataKey)}
          </span>
          <b>{fmt(p.value)}</b>
        </div>
      ))}
      {points.length > 1 && (
        <div className="tt-row tt-total">
          <span>合计</span>
          <b>{fmt(total)}</b>
        </div>
      )}
    </div>
  );
}

/** 构建最近日历日的账号序列，未知值留空，保留站点明确返回的 0。 */
export function buildGlobalDailyUsageData(
  accounts: AccountConfig[],
  statuses: Record<string, RefreshOutcome>,
  metric: Metric,
  days = 14,
  now = Date.now(),
  selectedCurrency?: string,
) {
  const windowDays = days === 7 || days === 14 || days === 30 ? days : 14;
  const date = new Date(now);
  const localToday = toLocalDateKey(date);
  const utcToday = date.toISOString().slice(0, 10);
  const requests: AccountSeries[] = [];
  const costs = new Map<string, AccountSeries[]>();
  const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);
  const add = (values: Map<string, number>, date: string, value: number) =>
    values.set(date, (values.get(date) ?? 0) + value);

  for (const { id, name, kind } of accounts) {
    const info = statuses[id]?.info;
    const today = kind === "openAi" ? utcToday : localToday;
    const from = shiftDateKey(today, -(windowDays - 1));
    const requestsByDate = new Map<string, number>();
    const costsByUnit = new Map<string, Map<string, number>>();
    for (const point of info?.dailyUsage ?? []) {
      const day = point?.date && normalizeLocalDay(point.date);
      if (!day || !inRange(day, from, today)) continue;
      if (typeof point.requests === "number" && Number.isFinite(point.requests)) {
        add(requestsByDate, day, point.requests);
      }
      if (typeof point.cost === "number" && Number.isFinite(point.cost)) {
        const unit = dashboardCurrency(point.costUnit || info?.balance?.currency);
        const values = costsByUnit.get(unit) ?? new Map<string, number>();
        add(values, day, point.cost);
        costsByUnit.set(unit, values);
      }
    }
    if (requestsByDate.size > 0) {
      requests.push({ id, name: name || id, values: requestsByDate, total: sum(requestsByDate.values()) });
    }
    for (const [unit, values] of costsByUnit) {
      const series = costs.get(unit) ?? [];
      series.push({ id, name: name || id, values, total: sum(values.values()) });
      costs.set(unit, series);
    }
  }

  const costUnits = [...costs.keys()].sort((a, b) => a.localeCompare(b));
  const defaultCurrency = [...costs.entries()].sort(([, a], [, b]) =>
    b.length - a.length || sum(b.map((item) => item.total)) - sum(a.map((item) => item.total)),
  )[0]?.[0];
  const unit = selectedCurrency && costs.has(selectedCurrency) ? selectedCurrency : defaultCurrency ?? "";
  const pool = metric === "cost" ? costs.get(unit) ?? [] : requests;
  const ranked = [...pool].sort((a, b) => b.total - a.total);
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

  const observed = pool.flatMap((s) => [...s.values.keys()]).sort();
  const dates = observed.length > 0 ? dateRange(observed[0], observed[observed.length - 1]) : [];
  const rows: Row[] = dates.map((date) => {
    const row: Row = { date };
    for (const a of top) row[a.id] = a.values.get(date) ?? null;
    if (rest.length > 0) {
      const other = rest.flatMap((a) => a.values.has(date) ? [a.values.get(date)!] : []);
      row[OTHER_KEY] = other.length > 0 ? sum(other) : null;
    }
    return row;
  });
  return { rows, series, unit, costUnits };
}

/**
 * 全账号用量趋势：合并各账号 dailyUsage，按用量历史日历日对齐。
 * 多账号使用按账号分色的独立折线，按总量取前 6，其余合并为「其他」。
 * 单账号保留普通面积图。指标可切换请求次数和费用。
 * 费用按币种选择，点击图例可隐藏或显示对应序列。
 */
export default function GlobalDailyUsageChart({ accounts, statuses, days = 14, now = Date.now() }: Props) {
  const gid = useId().replace(/:/g, "");
  const reducedMotion = usePrefersReducedMotion();
  const [metric, setMetric] = useState<Metric>("requests");
  const [currency, setCurrency] = useState<string>();
  /** 图例点击隐藏的序列（key 集合）；指标切换时重置，避免误藏另一指标的序列 */
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(new Set());
  const { rows, series, unit, costUnits } = useMemo(
    () => buildGlobalDailyUsageData(accounts, statuses, metric, days, now, currency),
    [accounts, statuses, metric, days, now, currency],
  );
  const hasCost = costUnits.length > 0;
  useEffect(() => setHiddenKeys(new Set()), [metric, unit]);

  // 数据刷新后费用数据可能消失：退回请求模式，避免停在无出口的空态
  useEffect(() => {
    if (!hasCost) setMetric("requests");
  }, [hasCost]);

  const empty = rows.length === 0 || series.length === 0;
  const multiSeries = series.length > 1;
  const Chart = multiSeries ? LineChart : AreaChart;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const onLegendClick = (e: any) => {
    const k = e?.dataKey;
    if (typeof k !== "string") return;
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <div className="chart-with-tabs">
      {hasCost && (
        <div className="usage-chart-controls">
          <div className="metric-tabs" role="tablist" aria-label="趋势指标切换">
            <button
              type="button"
              role="tab"
              aria-selected={metric === "requests"}
              className={`metric-tab${metric === "requests" ? " active" : ""}`}
              onClick={() => setMetric("requests")}
            >
              请求次数
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={metric === "cost"}
              className={`metric-tab${metric === "cost" ? " active" : ""}`}
              onClick={() => setMetric("cost")}
            >
              费用{metric === "cost" && unit && unit !== "UNKNOWN" && costUnits.length === 1 ? ` (${unit})` : ""}
            </button>
          </div>
          {metric === "cost" && costUnits.length > 1 && (
            <select className="chart-currency-select" aria-label="费用币种" value={unit} onChange={(event) => setCurrency(event.target.value)}>
              {costUnits.map((value) => <option key={value} value={value}>{value === "UNKNOWN" ? "未知单位" : value}</option>)}
            </select>
          )}
        </div>
      )}
      {empty ? (
        <ChartEmpty text={metric === "cost" ? "暂无费用统计数据" : "暂无用量数据"} />
      ) : (
        <ResponsiveContainer width="100%" height={220} className="chart-box">
          <Chart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {!multiSeries && (
              <defs>
                {series.map((s) => (
                  <linearGradient key={s.key} id={`gd-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
            )}
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              dy={6}
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickFormatter={(value: string) => dayLabel(value)}
            />
            <YAxis
              width={44}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickFormatter={(v: number) => formatCompact(v)}
            />
            <Tooltip
              content={<GlobalDailyTip series={series} metric={metric} unit={unit} />}
              labelFormatter={(value: unknown) => dayLabel(String(value))}
              cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 3" }}
            />
            {multiSeries && (
              <Legend
                iconType="circle"
                iconSize={7}
                wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
                onClick={onLegendClick}
              />
            )}
            {series.map((s) => {
              const isolated = rows.some((row, index) => typeof row[s.key] === "number"
                && typeof rows[index - 1]?.[s.key] !== "number" && typeof rows[index + 1]?.[s.key] !== "number");
              const dot = isolated ? { r: 3, strokeWidth: 0, fill: s.color } : false;
              return multiSeries ? (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={dot}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={!reducedMotion}
                  animationDuration={500}
                  hide={hiddenKeys.has(s.key)}
                />
              ) : (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#gd-${gid}-${s.key})`}
                  dot={dot}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={!reducedMotion}
                  animationDuration={500}
                  hide={hiddenKeys.has(s.key)}
                />
              );
            })}
          </Chart>
        </ResponsiveContainer>
      )}
      {multiSeries && !empty && <p className="chart-footnote">点击图例可隐藏 / 显示对应账号序列</p>}
    </div>
  );
}
