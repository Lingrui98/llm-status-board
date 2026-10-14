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
import { formatCompact, formatDecimal } from "../../format";
import { ChartEmpty, tsLabel } from "./shared";

interface Props {
  snapshots: BalanceSnapshot[];
  accountId: string;
  /** 空数据时的具体原因说明 */
  emptyNote?: string;
}

interface Row {
  label: string;
  fullTs: string;
  balance: number;
  currency: string;
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Row }>;
}

function TrendTip({ active, payload }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{r.fullTs}</div>
      <div className="tt-row">
        <span>余额</span>
        <b>
          {formatDecimal(r.balance)} {r.currency}
        </b>
      </div>
    </div>
  );
}

/** 单账号余额趋势折线图（数据点 <2 时降级为占位） */
export default function BalanceTrendChart({ snapshots, accountId, emptyNote }: Props) {
  const rows = useMemo<Row[]>(
    () =>
      snapshots
        .filter((s) => s.accountId === accountId)
        .slice()
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
        .map((s) => {
          const d = new Date(s.ts);
          return {
            label: tsLabel(s.ts),
            fullTs: isNaN(d.getTime()) ? s.ts : d.toLocaleString("zh-CN", { hour12: false }),
            balance: s.balance,
            currency: s.currency,
          };
        }),
    [snapshots, accountId],
  );

  if (rows.length < 2) return <ChartEmpty text={emptyNote} />;

  return (
    <ResponsiveContainer width="100%" height={160} className="chart-box">
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
          content={<TrendTip />}
          cursor={{ stroke: "rgba(127,147,175,0.35)", strokeDasharray: "3 3" }}
        />
        <Line
          type="monotone"
          dataKey="balance"
          stroke="#4da3ff"
          strokeWidth={2}
          dot={{ r: 2, strokeWidth: 0, fill: "#4da3ff" }}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
