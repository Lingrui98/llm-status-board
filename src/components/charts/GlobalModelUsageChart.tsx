import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AccountConfig, RefreshOutcome } from "../../types";
import { formatCompact, formatNumber } from "../../format";
import { ChartEmpty, usePrefersReducedMotion } from "./shared";
import { totalTokens } from "../../usageHistory";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
}

interface Row {
  model: string;
  requests: number | null;
  tokens: number | null;
  partialRequests: boolean;
  partialTokens: boolean;
  accounts: number; // 使用该模型的账号数
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Row }>;
}

function GlobalModelTip({ active, payload }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{r.model}</div>
      <div className="tt-row">
        <span>{r.partialRequests && r.requests !== null ? "请求数（已报告）" : "请求数"}</span>
        <b>{formatNumber(r.requests)}</b>
      </div>
      <div className="tt-row">
        <span>{r.partialTokens && r.tokens !== null ? "Tokens（已报告）" : "Tokens"}</span>
        <b>{formatCompact(r.tokens)}</b>
      </div>
      <div className="tt-row">
        <span>覆盖账号</span>
        <b>{r.accounts} 个</b>
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

type Metric = "requests" | "tokens";

function aggregateGlobalModels({ accounts, statuses }: Props): Row[] {
  const byModel = new Map<string, Row & { accountIds: Set<string> }>();
  for (const { id } of accounts) {
    for (const point of statuses[id]?.info?.modelUsage ?? []) {
      const model = point?.model?.trim();
      if (!model) continue;
      const requests = typeof point.requests === "number" && Number.isFinite(point.requests) ? point.requests : null;
      const tokens = totalTokens(point);
      if (requests === null && tokens === null) continue;
      const row = byModel.get(model) ?? {
        model, requests: null, tokens: null, partialRequests: false, partialTokens: false,
        accounts: 0, accountIds: new Set<string>(),
      };
      if (requests === null) row.partialRequests = true;
      else row.requests = (row.requests ?? 0) + requests;
      if (tokens === null) row.partialTokens = true;
      else row.tokens = (row.tokens ?? 0) + tokens;
      row.accountIds.add(id);
      byModel.set(model, row);
    }
  }
  return [...byModel.values()].map(({ accountIds, ...row }) => ({ ...row, accounts: accountIds.size }));
}

/** 按可用数据合并同名模型，切换指标后重新取 Top 8。 */
export default function GlobalModelUsageChart({ accounts, statuses }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const modelRows = useMemo(() => aggregateGlobalModels({ accounts, statuses }), [accounts, statuses]);
  const [selected, setSelected] = useState<Metric>("requests");
  const hasRequests = modelRows.some((row) => row.requests !== null);
  const hasTokens = modelRows.some((row) => row.tokens !== null);
  const metric = hasRequests && hasTokens ? selected : hasRequests ? "requests" : "tokens";
  const rows = modelRows.filter((row) => row[metric] !== null)
    .sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0))
    .slice(0, 8);

  if (rows.length === 0) return <ChartEmpty text="暂无模型用量数据" />;

  const height = Math.max(150, rows.length * 34 + 24);

  return (
    <div className="chart-with-tabs">
      {hasTokens && !hasRequests && <p className="chart-footnote">按 Tokens 排序</p>}
      {hasRequests && hasTokens && (
        <div className="metric-tabs" role="tablist" aria-label="模型用量指标">
          {(["requests", "tokens"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={metric === value}
              className={`metric-tab${metric === value ? " active" : ""}`} onClick={() => setSelected(value)}>
              {value === "requests" ? "请求次数" : "Tokens"}
            </button>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height} className="chart-box">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="model"
            width={128}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "currentColor" }}
            tickFormatter={(s: string) => (s.length > 17 ? `${s.slice(0, 16)}…` : s)}
          />
          <Tooltip content={<GlobalModelTip />} cursor={{ fill: "var(--chart-cursor-fill)" }} />
          <Bar
            dataKey={metric}
            name={metric === "requests" ? "请求数" : "Tokens"}
            fill="var(--ok)"
            radius={[0, 4, 4, 0]}
            barSize={16}
            isAnimationActive={!reducedMotion}
            animationDuration={500}
          >
            <LabelList dataKey={metric} content={renderBarValue} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
