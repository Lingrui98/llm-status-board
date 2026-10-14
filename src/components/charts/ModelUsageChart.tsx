import { useMemo } from "react";
import {
  Bar,
  BarChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsagePoint } from "../../types";
import { formatCompact, formatDecimal, formatNumber } from "../../format";
import { ChartEmpty } from "./shared";

interface Props {
  data: UsagePoint[] | null | undefined;
}

interface Row {
  model: string;
  value: number;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokens: number | null;
  cost: number | null;
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Row }>;
  mode: "cost" | "tokens";
  unit: string;
}

function ModelTip({ active, payload, mode, unit }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{r.model}</div>
      <div className="tt-row">
        <span>{mode === "cost" ? "花费" : "Tokens"}</span>
        <b>
          {mode === "cost"
            ? `${formatDecimal(r.value)} ${unit}`.trim()
            : formatNumber(r.value)}
        </b>
      </div>
      <div className="tt-row">
        <span>请求数</span>
        <b>{formatNumber(r.requests)}</b>
      </div>
      <div className="tt-row">
        <span>输入 Tokens</span>
        <b>{formatNumber(r.inputTokens)}</b>
      </div>
      <div className="tt-row">
        <span>输出 Tokens</span>
        <b>{formatNumber(r.outputTokens)}</b>
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderBarValue(props: any) {
  const { x, y, width, height, value } = props;
  return (
    <text
      x={Number(x) + Number(width) + 6}
      y={Number(y) + Number(height) / 2}
      fill="currentColor"
      fontSize={11}
      dominantBaseline="central"
    >
      {formatCompact(Number(value))}
    </text>
  );
}

/** 按模型用量水平条形图：按 cost（无 cost 时按 tokens）降序取 Top 8 */
export default function ModelUsageChart({ data }: Props) {
  const { rows, mode, unit } = useMemo(() => {
    const pts = (data ?? []).filter((p): p is UsagePoint & { model: string } => !!p && !!p.model);
    const useCost = pts.some((p) => p.cost !== null && p.cost !== undefined);
    const unit = useCost ? (pts.find((p) => p.costUnit)?.costUnit ?? "") : "";
    const rows: Row[] = pts
      .map((p) => ({
        model: String(p.model),
        value: useCost ? (p.cost ?? NaN) : (p.tokens ?? NaN),
        requests: p.requests ?? null,
        inputTokens: p.inputTokens ?? null,
        outputTokens: p.outputTokens ?? null,
        tokens: p.tokens ?? null,
        cost: p.cost ?? null,
      }))
      .filter((r) => !Number.isNaN(r.value))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    return { rows, mode: (useCost ? "cost" : "tokens") as "cost" | "tokens", unit };
  }, [data]);

  if (rows.length === 0) return <ChartEmpty />;

  const height = Math.max(140, rows.length * 34 + 24);

  return (
    <ResponsiveContainer width="100%" height={height} className="chart-box">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="model"
          width={118}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={(s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s)}
        />
        <Tooltip
          content={<ModelTip mode={mode} unit={unit} />}
          cursor={{ fill: "rgba(127,147,175,0.10)" }}
        />
        <Bar dataKey="value" fill="#4da3ff" radius={[0, 4, 4, 0]} barSize={16}>
          <LabelList dataKey="value" content={renderBarValue} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
