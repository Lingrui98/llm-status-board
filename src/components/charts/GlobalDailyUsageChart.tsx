import { useEffect, useId, useMemo, useState } from "react";
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
import { formatCompact, formatDecimal, formatNumber } from "../../format";
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

function GlobalDailyTip({ active, payload, label, series, metric, unit }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const nameOf = (k: string | number | undefined) =>
    series.find((s) => s.key === k)?.name ?? String(k ?? "");
  const fmt = (v: number) =>
    metric === "cost" ? `${formatDecimal(v)} ${unit}`.trim() : formatNumber(v);
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
 * 全账号用量趋势（近 14 天）：合并各账号 dailyUsage，按 date 对齐。
 * 多账号 → 按账号分色的堆叠面积图（按总量取前 6，其余合并为「其他」）；
 * 单账号 → 退化为普通面积图。
 * 指标可切换：请求次数 / 费用（费用模式只画主币种账号，避免不同单位混轴）；
 * 点击图例可隐藏/显示对应账号序列。
 */
export default function GlobalDailyUsageChart({ accounts, statuses }: Props) {
  const gid = useId().replace(/:/g, "");
  const [metric, setMetric] = useState<Metric>("requests");
  /** 图例点击隐藏的序列（key 集合）；指标切换时重置，避免误藏另一指标的序列 */
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setHiddenKeys(new Set()), [metric]);

  // 第一步：按账号汇总两套序列（与指标无关）
  const perAccount = useMemo<AccountSeries[]>(() => {
    const list: AccountSeries[] = [];
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
        const d = String(p.date);
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
      list.push({ id: acc.id, name: acc.name || acc.id, reqTotal, reqByDate, costTotal, costByDate, costUnit });
    }
    return list;
  }, [accounts, statuses]);

  const hasCost = perAccount.some((a) => a.costByDate.size > 0);

  // 数据刷新后费用数据可能消失：退回请求模式，避免停在无出口的空态
  useEffect(() => {
    if (!hasCost) setMetric("requests");
  }, [hasCost]);

  // 第二步：按当前指标挑选账号、对齐日期成行
  const { rows, series, unit, excludedCount, excludedUnits } = useMemo(() => {
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
      return { rows: [] as Row[], series: [] as SeriesDef[], unit, excludedCount, excludedUnits };
    }

    const valueOf = (a: AccountSeries, d: string) =>
      metric === "cost" ? (a.costByDate.get(d) ?? 0) : (a.reqByDate.get(d) ?? 0);
    const totalOf = (a: AccountSeries) => (metric === "cost" ? a.costTotal : a.reqTotal);

    const allDates = [...new Set(pool.flatMap((a) => [...(metric === "cost" ? a.costByDate : a.reqByDate).keys()]))]
      .sort((a, b) => a.localeCompare(b))
      .slice(-14);

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
      const row: Row = { date: dayLabel(d) };
      for (const a of top) row[a.id] = valueOf(a, d);
      if (rest.length > 0) row[OTHER_KEY] = rest.reduce((acc, a) => acc + valueOf(a, d), 0);
      return row;
    });
    return { rows, series, unit, excludedCount, excludedUnits };
  }, [perAccount, metric]);

  const empty = rows.length < 2 || series.length === 0;
  const stacked = series.length > 1;

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
              content={<GlobalDailyTip series={series} metric={metric} unit={unit} />}
              cursor={{ stroke: "rgba(127,147,175,0.35)", strokeDasharray: "3 3" }}
            />
            {stacked && (
              <Legend
                iconType="circle"
                iconSize={7}
                wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
                onClick={onLegendClick}
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
                hide={hiddenKeys.has(s.key)}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
      {metric === "cost" && excludedCount > 0 && (
        <p className="chart-footnote">
          费用模式仅统计 {unit || "主币种"} 账户；另有 {excludedCount} 个账号使用 {excludedUnits}，未混入本图。
        </p>
      )}
      {stacked && !empty && <p className="chart-footnote">点击图例可隐藏 / 显示对应账号序列</p>}
    </div>
  );
}
