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
import type { AccountConfig, RefreshOutcome, UsagePoint } from "../../types";
import { formatCompact, formatDecimal, formatNumber } from "../../format";
import { ChartEmpty, dayLabel, usePrefersReducedMotion } from "./shared";
import { normalizeLocalDay } from "../../localDay";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
  /** 展示最近 7 / 14 / 30 个有数据的日历日，默认 14 */
  days?: number;
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

type Row = { date: string } & { [key: string]: number | string };

/** 每个账号两套按日序列（请求数 / 费用），指标切换时复用 */
interface AccountSeries {
  id: string;
  name: string;
  reqTotal: number;
  reqByDate: Map<string, number>;
  costTotal: number;
  costByDate: Map<string, number>;
  costUnit: string | null;
}

interface TipProps {
  active?: boolean;
  label?: string;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number | string; color?: string }>;
  series: SeriesDef[];
  metric: Metric;
  unit: string;
}

export function GlobalDailyTip({ active, payload, label, series, metric, unit }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const nameOf = (k: string | number | undefined) =>
    series.find((s) => s.key === k)?.name ?? String(k ?? "");
  const fmt = (v: number) =>
    metric === "cost" ? `${formatDecimal(v)} ${unit}`.trim() : formatNumber(v);
  const total = payload.reduce((acc, p) => acc + (typeof p.value === "number" ? p.value : 0), 0);
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{label ? dayLabel(label) : ""}</div>
      {[...payload].reverse().map((p) => (
        <div className="tt-row" key={String(p.dataKey)}>
          <span>
            <i className="tt-swatch" style={{ background: p.color }} />
            {nameOf(p.dataKey)}
          </span>
          <b>{fmt(typeof p.value === "number" ? p.value : 0)}</b>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="tt-row tt-total">
          <span>合计</span>
          <b>{fmt(total)}</b>
        </div>
      )}
    </div>
  );
}

/** 主币种：有费用数据的账号数最多者；并列时取费用总额更高的 */
function pickPrimaryUnit(list: AccountSeries[]): string {
  const stats = new Map<string, { accounts: number; cost: number }>();
  for (const a of list) {
    const u = a.costUnit ?? "";
    const e = stats.get(u) ?? { accounts: 0, cost: 0 };
    e.accounts += 1;
    e.cost += a.costTotal;
    stats.set(u, e);
  }
  let best = "";
  let bestKey = { accounts: -1, cost: -1 };
  for (const [u, e] of stats) {
    if (e.accounts > bestKey.accounts || (e.accounts === bestKey.accounts && e.cost > bestKey.cost)) {
      best = u;
      bestKey = e;
    }
  }
  return best;
}

/**
 * 构建图表数据。日期先归一为用量历史日历日，再按账号汇总，避免原始格式造成重复行。
 * 该函数不读取组件状态，便于直接验证日期合并、指标筛选和 days 截断。
 */
export function buildGlobalDailyUsageData(
  accounts: AccountConfig[],
  statuses: Record<string, RefreshOutcome>,
  metric: Metric,
  days = 14,
) {
  const windowDays = days === 7 || days === 14 || days === 30 ? days : 14;
  const perAccount: AccountSeries[] = [];
  for (const acc of accounts) {
    const pts = (statuses[acc.id]?.info?.dailyUsage ?? []).filter(
      (p): p is UsagePoint & { date: string } => !!p && !!p.date,
    );
    if (pts.length === 0) continue;
    const reqByDate = new Map<string, number>();
    const costByDate = new Map<string, number>();
    let reqTotal = 0;
    let costTotal = 0;
    let costUnit: string | null = null;
    for (const p of pts) {
      const d = normalizeLocalDay(String(p.date));
      if (!d) continue;
      if (p.requests !== null && p.requests !== undefined) {
        reqByDate.set(d, (reqByDate.get(d) ?? 0) + p.requests);
        reqTotal += p.requests;
      }
      if (p.cost !== null && p.cost !== undefined) {
        costByDate.set(d, (costByDate.get(d) ?? 0) + p.cost);
        costTotal += p.cost;
        if (!costUnit && p.costUnit) costUnit = p.costUnit;
      }
    }
    if (reqByDate.size === 0 && costByDate.size === 0) continue;
    perAccount.push({ id: acc.id, name: acc.name || acc.id, reqTotal, reqByDate, costTotal, costByDate, costUnit });
  }

  const hasCost = perAccount.some((a) => a.costByDate.size > 0);
  let pool: AccountSeries[];
  let unit = "";
  let excludedCount = 0;
  let excludedUnits = "";
  if (metric === "cost") {
    const withCost = perAccount.filter((a) => a.costByDate.size > 0);
    // 不同 costUnit 不混轴：只画主币种，其余在脚注说明
    unit = pickPrimaryUnit(withCost);
    pool = withCost.filter((a) => (a.costUnit ?? "") === unit);
    const excluded = withCost.filter((a) => (a.costUnit ?? "") !== unit);
    excludedCount = excluded.length;
    excludedUnits = [...new Set(excluded.map((a) => a.costUnit ?? "未知单位"))].join("、");
  } else {
    pool = perAccount.filter((a) => a.reqByDate.size > 0);
  }
  if (pool.length === 0) {
    return { rows: [] as Row[], series: [] as SeriesDef[], unit, excludedCount, excludedUnits, hasCost };
  }

  const valueOf = (a: AccountSeries, d: string) =>
    metric === "cost" ? (a.costByDate.get(d) ?? 0) : (a.reqByDate.get(d) ?? 0);
  const allDates = [...new Set(pool.flatMap((a) => [...(metric === "cost" ? a.costByDate : a.reqByDate).keys()]))]
    .sort((a, b) => a.localeCompare(b))
    .slice(-windowDays);
  // 前 6 排名只看当前时间窗口，避免窗口外的高历史总量挤占可见系列。
  const totalOf = (a: AccountSeries) => allDates.reduce((total, date) => total + valueOf(a, date), 0);

  const ranked = [...pool].sort((a, b) => totalOf(b) - totalOf(a));
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
    const row: Row = { date: d };
    for (const a of top) row[a.id] = valueOf(a, d);
    if (rest.length > 0) row[OTHER_KEY] = rest.reduce((acc, a) => acc + valueOf(a, d), 0);
    return row;
  });
  return { rows, series, unit, excludedCount, excludedUnits, hasCost };
}

/**
 * 全账号用量趋势：合并各账号 dailyUsage，按用量历史日历日对齐。
 * 多账号使用按账号分色的独立折线，按总量取前 6，其余合并为「其他」。
 * 单账号保留普通面积图。指标可切换请求次数和费用。
 * 费用模式只画主币种账号，点击图例可隐藏或显示对应序列。
 */
export default function GlobalDailyUsageChart({ accounts, statuses, days = 14 }: Props) {
  const gid = useId().replace(/:/g, "");
  const reducedMotion = usePrefersReducedMotion();
  const [metric, setMetric] = useState<Metric>("requests");
  /** 图例点击隐藏的序列（key 集合）；指标切换时重置，避免误藏另一指标的序列 */
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setHiddenKeys(new Set()), [metric]);

  const { rows, series, unit, excludedCount, excludedUnits, hasCost } = useMemo(
    () => buildGlobalDailyUsageData(accounts, statuses, metric, days),
    [accounts, statuses, metric, days],
  );

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
            费用{metric === "cost" && unit ? ` (${unit})` : ""}
          </button>
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
            {series.map((s) =>
              multiSeries ? (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={rows.length === 1 ? { r: 3, strokeWidth: 0, fill: s.color } : false}
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
                  dot={rows.length === 1 ? { r: 3, strokeWidth: 0, fill: s.color } : false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={!reducedMotion}
                  animationDuration={500}
                  hide={hiddenKeys.has(s.key)}
                />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      )}
      {metric === "cost" && excludedCount > 0 && (
        <p className="chart-footnote">
          费用模式仅统计 {unit || "主币种"} 账户；另有 {excludedCount} 个账号使用 {excludedUnits}，未混入本图。
        </p>
      )}
      {multiSeries && !empty && <p className="chart-footnote">点击图例可隐藏 / 显示对应账号序列</p>}
    </div>
  );
}
