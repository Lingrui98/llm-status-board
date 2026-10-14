import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsagePoint } from "../../types";
import { formatCompact, formatDecimal, formatNumber } from "../../format";
import { ChartEmpty, dayLabel } from "./shared";

interface Props {
  data: UsagePoint[] | null | undefined;
  /** 空数据时的具体原因说明（如"官方接口不提供历史用量"） */
  emptyNote?: string;
}

interface Row {
  date: string;
  value: number | null;
  requests: number | null;
  tokens: number | null;
  cost: number | null;
  costUnit: string | null;
}

interface TipProps {
  active?: boolean;
  label?: string;
  payload?: ReadonlyArray<{ payload: Row }>;
  unit: string;
}

function DailyTip({ active, payload, label, unit }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{label}</div>
      <div className="tt-row">
        <span>请求数</span>
        <b>{formatNumber(r.requests)}</b>
      </div>
      <div className="tt-row">
        <span>Tokens</span>
        <b>{formatCompact(r.tokens)}</b>
      </div>
      <div className="tt-row">
        <span>花费</span>
        <b>{r.cost === null ? "—" : `${formatDecimal(r.cost)} ${r.costUnit ?? unit}`.trim()}</b>
      </div>
    </div>
  );
}

/** 近 14 天用量面积图：有 cost 优先画花费（单位跟随 costUnit），否则画请求数 */
export default function DailyUsageChart({ data, emptyNote }: Props) {
  const gid = useId().replace(/:/g, "");
  const { rows, unit } = useMemo(() => {
    const pts = (data ?? [])
      .filter((p): p is UsagePoint & { date: string } => !!p && !!p.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-14);
    const useCost = pts.some((p) => p.cost !== null && p.cost !== undefined);
    const unit = useCost ? (pts.find((p) => p.costUnit)?.costUnit ?? "") : "";
    const rows: Row[] = pts.map((p) => {
      const inTok = p.inputTokens ?? null;
      const outTok = p.outputTokens ?? null;
      const tokens =
        p.tokens ?? (inTok !== null || outTok !== null ? (inTok ?? 0) + (outTok ?? 0) : null);
      return {
        date: dayLabel(String(p.date)),
        value: useCost ? (p.cost ?? null) : (p.requests ?? null),
        requests: p.requests ?? null,
        tokens,
        cost: p.cost ?? null,
        costUnit: p.costUnit ?? null,
      };
    });
    // 只有选定的主指标有值的点才参与渲染
    return { rows: rows.filter((r) => r.value !== null), unit };
  }, [data]);

  if (rows.length < 2) return <ChartEmpty text={emptyNote} />;

  return (
    <ResponsiveContainer width="100%" height={180} className="chart-box">
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`du-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4da3ff" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#4da3ff" stopOpacity={0.02} />
          </linearGradient>
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
          content={<DailyTip unit={unit} />}
          cursor={{ stroke: "rgba(127,147,175,0.35)", strokeDasharray: "3 3" }}
        />
        <Area
          type="monotone"
          dataKey="value"
          name={unit ? `花费 (${unit})` : "请求数"}
          stroke="#4da3ff"
          strokeWidth={2}
          fill={`url(#du-${gid})`}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
