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
import type { AccountConfig, RefreshOutcome, UsagePoint } from "../../types";
import { formatCompact, formatNumber } from "../../format";
import { ChartEmpty } from "./shared";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
}

interface Row {
  model: string;
  requests: number;
  tokens: number | null;
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
        <span>请求数</span>
        <b>{formatNumber(r.requests)}</b>
      </div>
      <div className="tt-row">
        <span>Tokens</span>
        <b>{formatNumber(r.tokens)}</b>
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

/**
 * 全账号模型用量 Top 8：合并所有账号的 modelUsage，
 * 同名模型 requests 求和后降序排列（水平条形图）。
 */
export default function GlobalModelUsageChart({ accounts, statuses }: Props) {
  const rows = useMemo<Row[]>(() => {
    const byModel = new Map<string, { requests: number; tokens: number; hasTokens: boolean; accountIds: Set<string> }>();
    for (const acc of accounts) {
      const pts = (statuses[acc.id]?.info?.modelUsage ?? []).filter(
        (p): p is UsagePoint & { model: string } => !!p && !!p.model && p.requests !== null && p.requests !== undefined,
      );
      for (const p of pts) {
        const name = String(p.model);
        const entry = byModel.get(name) ?? { requests: 0, tokens: 0, hasTokens: false, accountIds: new Set<string>() };
        entry.requests += p.requests ?? 0;
        if (p.tokens !== null && p.tokens !== undefined) {
          entry.tokens += p.tokens;
          entry.hasTokens = true;
        }
        entry.accountIds.add(acc.id);
        byModel.set(name, entry);
      }
    }
    return [...byModel.entries()]
      .map(([model, e]) => ({
        model,
        requests: e.requests,
        tokens: e.hasTokens ? e.tokens : null,
        accounts: e.accountIds.size,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8);
  }, [accounts, statuses]);

  if (rows.length === 0) return <ChartEmpty text="暂无模型用量数据" />;

  const height = Math.max(150, rows.length * 34 + 24);

  return (
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
        <Tooltip content={<GlobalModelTip />} cursor={{ fill: "rgba(127,147,175,0.10)" }} />
        <Bar dataKey="requests" name="请求数" fill="#3ecf8e" radius={[0, 4, 4, 0]} barSize={16}>
          <LabelList dataKey="requests" content={renderBarValue} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
