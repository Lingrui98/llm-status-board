import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountConfig, BalanceSnapshot } from "../../types";
import { formatDecimal } from "../../format";
import { ChartEmpty, usePrefersReducedMotion } from "./shared";
import { SERIES_COLORS } from "./GlobalDailyUsageChart";
import TrendRangeControls, { useTrendRange } from "../TrendRangeControls";
import { sampleTrendRows, TREND_GAP_MS, trendTick, trendTicks } from "../../trendHistory";

interface Props {
  snapshots: BalanceSnapshot[];
  accounts: AccountConfig[];
}

const MAX_LINES = 6;

interface SeriesDef {
  key: string; // accountId
  name: string;
  color: string;
  points: Row[];
}

type Row = { timestamp: number } & Record<string, number | null>;

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number | string; color?: string; payload: Row }>;
  series: SeriesDef[];
  currency: string;
}

function MultiTrendTip({ active, payload, series, currency }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const nameOf = (k: string | number | undefined) =>
    series.find((s) => s.key === k)?.name ?? String(k ?? "");
  const timestamp = payload[0]?.payload?.timestamp;
  const title = timestamp == null ? "" : new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{title}</div>
      {payload.map((p) => (
        <div className="tt-row" key={String(p.dataKey)}>
          <span>
            <i className="tt-swatch" style={{ background: p.color }} />
            {nameOf(p.dataKey)}
          </span>
          <b>
            {typeof p.value === "number" ? `${formatDecimal(p.value)} ${currency}` : "—"}
          </b>
        </div>
      ))}
    </div>
  );
}

/**
 * 余额趋势（多账号）：BalanceSnapshot 按 accountId 分组，每账号一条折线。
 * 不同 currency 不混轴：取账号数最多的币种绘制，标题注明币种；
 * 账号 > 6 时只画最新余额最高的 6 条。
 */
export default function GlobalBalanceTrendChart({ snapshots, accounts }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const available = useMemo(() => {
    const ids = new Set(accounts.filter((a) => a.enabled).map((a) => a.id));
    return snapshots.filter((s) => ids.has(s.accountId) && Number.isFinite(Date.parse(s.ts)) && Number.isFinite(s.balance));
  }, [snapshots, accounts]);
  const range = useTrendRange(available);
  const { rows, series, currency } = useMemo(() => {
    const nameOf = new Map(accounts.map((a) => [a.id, a.name || a.id]));

    // 按币种分组 → 取「有快照的账号数」最多的币种（并列时取快照更多的）
    const byCurrency = new Map<string, BalanceSnapshot[]>();
    for (const s of available) {
      const list = byCurrency.get(s.currency) ?? [];
      list.push(s);
      byCurrency.set(s.currency, list);
    }
    let currency = "";
    let best: BalanceSnapshot[] = [];
    for (const [cur, list] of byCurrency) {
      const curAccounts = new Set(list.map((s) => s.accountId)).size;
      const bestAccounts = new Set(best.map((s) => s.accountId)).size;
      if (curAccounts > bestAccounts || (curAccounts === bestAccounts && list.length > best.length)) {
        currency = cur;
        best = list;
      }
    }

    // 该币种下按账号分组，按最新余额取前 6
    const byAccount = new Map<string, BalanceSnapshot[]>();
    for (const s of range.filtered) {
      if (s.currency !== currency) continue;
      const list = byAccount.get(s.accountId) ?? [];
      list.push(s);
      byAccount.set(s.accountId, list);
    }
    const ranked = [...byAccount.entries()]
      .map(([id, list]) => {
        const sorted = list.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        return { id, sorted, latest: sorted[sorted.length - 1]?.balance ?? 0 };
      })
      .sort((a, b) => b.latest - a.latest)
      .slice(0, MAX_LINES);

    const series: SeriesDef[] = ranked.map((a, i) => {
      const points: Row[] = [];
      for (const snapshot of a.sorted) {
        const ts = Date.parse(snapshot.ts);
        const previous = points[points.length - 1];
        if (previous && ts - previous.timestamp > TREND_GAP_MS) {
          points.push({ timestamp: previous.timestamp + (ts - previous.timestamp) / 2, [a.id]: null });
        }
        points.push({ timestamp: ts, [a.id]: snapshot.balance });
      }
      return { key: a.id, name: nameOf.get(a.id) ?? a.id, color: SERIES_COLORS[i % SERIES_COLORS.length],
        points: sampleTrendRows(points, (r) => [r[a.id]]) };
    });

    // 按时间戳对齐成行（同一时间点的快照合并到一行），按原始 ts 排序
    const byTs = new Map<number, Row>();
    for (const a of ranked) {
      for (const s of a.sorted) {
        const ts = Date.parse(s.ts);
        const row = byTs.get(ts) ?? {
          timestamp: ts,
        };
        row[a.id] = s.balance;
        byTs.set(ts, row);
      }
    }
    const sorted = [...byTs.keys()]
      .sort((x, y) => x - y)
      .map((ts) => byTs.get(ts)!);
    const withGaps: Row[] = [];
    for (const row of sorted) {
      const previous = withGaps[withGaps.length - 1];
      if (previous && row.timestamp - previous.timestamp > TREND_GAP_MS) {
        withGaps.push({ timestamp: previous.timestamp + (row.timestamp - previous.timestamp) / 2 });
      }
      withGaps.push(row);
    }
    const rows = sampleTrendRows(withGaps, (r) => series.map((s) => typeof r[s.key] === "number" ? r[s.key] as number : null));
    return { rows, series, currency };
  }, [available, range.filtered, accounts]);

  const multi = series.length > 1;

  return (
    <div className="global-balance-trend">
      <TrendRangeControls selection={range.selection} onChange={range.setSelection} bounds={range.bounds} window={range.window} />
      {rows.length < 2 || series.length === 0 ? <ChartEmpty text={range.window.error ?? "此时间范围余额记录不足，可选择更长时间或“全部”"} /> : (
        <ResponsiveContainer width="100%" height={200} className="chart-box">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={[range.window.from, range.window.to]}
              allowDataOverflow
              allowDuplicatedCategory={false}
              ticks={trendTicks(range.window)}
              tickCount={5}
              tickFormatter={(ts: number) => trendTick(ts, range.window)}
              tickLine={false}
              axisLine={false}
              dy={6}
              tick={{ fontSize: 11, fill: "currentColor" }}
              minTickGap={24}
            />
            <YAxis
              width={52}
              domain={["auto", "auto"]}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickFormatter={(v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}
            />
            <Tooltip
              content={<MultiTrendTip series={series} currency={currency} />}
              cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 3" }}
            />
            {multi && (
              <Legend iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
            )}
            {series.map((s) => (
              <Line
                key={s.key}
                type="linear"
                dataKey={s.key}
                data={s.points}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                dot={multi || rows.length > 100 ? false : { r: 2, strokeWidth: 0, fill: s.color }}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive={!reducedMotion && rows.length < 300}
                animationDuration={500}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** 供标题注明币种的选币逻辑已移至 shared.tsx（避免懒加载边界外泄 recharts） */
export { pickTrendCurrency } from "./shared";
