import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BalanceSnapshot } from "../../types";
import { formatDecimal } from "../../format";
import { ChartEmpty, usePrefersReducedMotion } from "./shared";
import { historyBounds, resolveTrendWindow, sampleTrendRows, TREND_GAP_MS, trendTick, trendTicks } from "../../trendHistory";
import type { TrendWindow } from "../../trendHistory";

interface Props {
  snapshots: BalanceSnapshot[];
  accountId: string;
  metric?: "balance" | "total";
  window?: TrendWindow;
  /** 空数据时的具体原因说明 */
  emptyNote?: string;
}

interface Row {
  timestamp: number;
  amount: number | null;
  currency: string;
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Row }>;
  metric: "balance" | "total";
}

function TrendTip({ active, payload, metric }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  if (r.amount == null) return null;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{new Date(r.timestamp).toLocaleString("zh-CN", { hour12: false })}</div>
      <div className="tt-row">
        <span>{metric === "total" ? "总额度" : "余额"}</span>
        <b>
          {formatDecimal(r.amount)} {r.currency}
        </b>
      </div>
    </div>
  );
}

/** 单账号余额或总额度趋势（数据点 <2 时降级为占位） */
export default function BalanceTrendChart({ snapshots, accountId, metric = "balance", window, emptyNote }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { rows, chartWindow, count } = useMemo(() => {
    const own = snapshots.filter((s) => s.accountId === accountId);
    const chartWindow = window ?? resolveTrendWindow({ preset: "all", from: "", to: "" }, historyBounds(own), Date.now());
    const samples: Row[] = own
      .filter((s) => typeof s[metric] === "number" && Number.isFinite(s[metric]))
      .map((s) => ({ timestamp: Date.parse(s.ts), amount: s[metric] as number, currency: s.currency }))
      .filter((r) => !chartWindow.error && Number.isFinite(r.timestamp) && r.timestamp >= chartWindow.from && r.timestamp <= chartWindow.to)
      .sort((a, b) => a.timestamp - b.timestamp);
    const withGaps: Row[] = [];
    for (const row of samples) {
      const previous = withGaps[withGaps.length - 1];
      if (previous && row.timestamp - previous.timestamp > TREND_GAP_MS) {
        withGaps.push({ ...row, timestamp: previous.timestamp + (row.timestamp - previous.timestamp) / 2, amount: null });
      }
      withGaps.push(row);
    }
    // 阶梯图先删除恒定区间内部点，保留每次额度变化的真实时刻及空档边界。
    const visible = metric === "total" ? withGaps.filter((row, i) =>
      i === 0 || i === withGaps.length - 1 || row.amount == null ||
      row.amount !== withGaps[i - 1].amount || row.amount !== withGaps[i + 1].amount) : withGaps;
    return { rows: sampleTrendRows(visible, (r) => [r.amount]), chartWindow, count: samples.length };
  }, [snapshots, accountId, metric, window]);

  if (count < 2) return <ChartEmpty text={emptyNote} />;

  return (
    <div>
      <div className="trend-unit">{rows[rows.length - 1]?.currency}</div>
      <ResponsiveContainer width="100%" height={metric === "balance" ? 220 : 140} className="chart-box">
        <LineChart data={rows} syncId={`account-trend-${accountId}`} syncMethod="value" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={[chartWindow.from, chartWindow.to]}
            allowDataOverflow
            allowDuplicatedCategory={false}
            ticks={trendTicks(chartWindow)}
            tickFormatter={(ts: number) => trendTick(ts, chartWindow)}
            tickCount={5}
            tickLine={false}
            axisLine={false}
            dy={6}
            tick={{ fontSize: 11, fill: "currentColor" }}
            minTickGap={24}
          />
          <YAxis
            width={68}
            domain={["auto", "auto"]}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "currentColor" }}
            tickFormatter={(v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}
          />
          <Tooltip
            content={<TrendTip metric={metric} />}
            cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 3" }}
          />
          <Line
            type={metric === "total" ? "stepAfter" : "linear"}
            dataKey="amount"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={rows.length > 100 ? false : { r: 2, strokeWidth: 0, fill: "var(--accent)" }}
            activeDot={{ r: 3, strokeWidth: 0 }}
            connectNulls={false}
            isAnimationActive={!reducedMotion && rows.length < 300}
            animationDuration={500}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
