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
import { formatCompact, formatDecimal } from "../../format";
import { ChartEmpty, tsLabel } from "./shared";
import { SERIES_COLORS } from "./GlobalDailyUsageChart";

interface Props {
  snapshots: BalanceSnapshot[];
  accounts: AccountConfig[];
}

const MAX_LINES = 6;

interface SeriesDef {
  key: string; // accountId
  name: string;
  color: string;
}

type Row = { label: string; fullTs: string } & Record<string, number | string>;

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
  const title = payload[0]?.payload?.fullTs ?? "";
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
  const { rows, series, currency } = useMemo(() => {
    const nameOf = new Map(accounts.map((a) => [a.id, a.name || a.id]));

    // 按币种分组 → 取「有快照的账号数」最多的币种（并列时取快照更多的）
    const byCurrency = new Map<string, BalanceSnapshot[]>();
    for (const s of snapshots) {
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
    for (const s of best) {
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

    const series: SeriesDef[] = ranked.map((a, i) => ({
      key: a.id,
      name: nameOf.get(a.id) ?? a.id,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));

    // 按时间戳对齐成行（同一时间点的快照合并到一行），按原始 ts 排序
    const byTs = new Map<string, Row>();
    for (const a of ranked) {
      for (const s of a.sorted) {
        const d = new Date(s.ts);
        const row = byTs.get(s.ts) ?? {
          label: tsLabel(s.ts),
          fullTs: isNaN(d.getTime()) ? s.ts : d.toLocaleString("zh-CN", { hour12: false }),
        };
        row[a.id] = s.balance;
        byTs.set(s.ts, row);
      }
    }
    const rows = [...byTs.keys()]
      .sort((x, y) => new Date(x).getTime() - new Date(y).getTime())
      .map((ts) => byTs.get(ts)!);
    return { rows, series, currency };
  }, [snapshots, accounts]);

  if (rows.length < 2 || series.length === 0) return <ChartEmpty text="暂无余额历史（至少两次刷新后生成）" />;

  const multi = series.length > 1;

  return (
    <ResponsiveContainer width="100%" height={200} className="chart-box">
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="rgba(127,147,175,0.14)" vertical={false} />
        <XAxis
          dataKey="label"
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
          tickFormatter={(v: number) => formatCompact(v)}
        />
        <Tooltip
          content={<MultiTrendTip series={series} currency={currency} />}
          cursor={{ stroke: "rgba(127,147,175,0.35)", strokeDasharray: "3 3" }}
        />
        {multi && (
          <Legend iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
        )}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            dot={multi ? false : { r: 2, strokeWidth: 0, fill: s.color }}
            activeDot={{ r: 3, strokeWidth: 0 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** 供标题注明币种：与组件内部一致的选币逻辑（账号数最多的币种） */
export function pickTrendCurrency(snapshots: BalanceSnapshot[]): string | null {
  const byCurrency = new Map<string, Set<string>>();
  for (const s of snapshots) {
    const set = byCurrency.get(s.currency) ?? new Set<string>();
    set.add(s.accountId);
    byCurrency.set(s.currency, set);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [cur, set] of byCurrency) {
    if (set.size > bestCount) {
      best = cur;
      bestCount = set.size;
    }
  }
  return best;
}
