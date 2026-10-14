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
import { formatDecimal } from "../../format";
import { ChartEmpty, dayLabel, usePrefersReducedMotion } from "./shared";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
}

interface Row {
  name: string;
  cost: number;
  date: string;
}

interface Section {
  unit: string;
  rows: Row[];
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Row }>;
  unit: string;
}

function CostTip({ active, payload, unit }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const r = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-title">{r.name}</div>
      <div className="tt-row">
        <span>费用</span>
        <b>
          {formatDecimal(r.cost)} {unit}
        </b>
      </div>
      <div className="tt-row">
        <span>数据日期</span>
        <b>{dayLabel(r.date)}</b>
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderCostValue(props: any) {
  const { x, y, width, height, value } = props;
  return (
    <text
      x={Number(x) + Number(width) + 6}
      y={Number(y) + Number(height) / 2}
      fill="currentColor"
      fontSize={11}
      dominantBaseline="central"
    >
      {formatDecimal(Number(value))}
    </text>
  );
}

/** 币种分节排序：USD → CNY → 其他单位（credits 等）按字典序 */
function unitOrder(a: string, b: string): number {
  const rank = (u: string) => (u === "USD" ? 0 : u === "CNY" ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * 今日费用构成（全局）：每个账号取 dailyUsage 中最近一个有 cost 记录的日期
 * （多数站点即"今日"，无当日数据时回退到最近一天），按账号做水平条形对比。
 * 不同 costUnit 不混轴：USD / CNY 各自成节，credits 类单位单独一节。
 */
export default function CostBreakdownChart({ accounts, statuses }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { sections, mixed } = useMemo(() => {
    const byUnit = new Map<string, Row[]>();
    let distinctDates = 0;
    const seenDates = new Set<string>();
    for (const acc of accounts) {
      const pts = (statuses[acc.id]?.info?.dailyUsage ?? []).filter(
        (p): p is UsagePoint & { date: string; cost: number } =>
          !!p && !!p.date && p.cost !== null && p.cost !== undefined,
      );
      if (pts.length === 0) continue;
      // 该账号最近一个有费用记录的日期
      const latest = pts.map((p) => String(p.date)).sort((a, b) => a.localeCompare(b)).slice(-1)[0];
      const dayPts = pts.filter((p) => String(p.date) === latest);
      const cost = dayPts.reduce((acc2, p) => acc2 + (p.cost ?? 0), 0);
      const unit = dayPts.find((p) => p.costUnit)?.costUnit ?? "其他";
      const list = byUnit.get(unit) ?? [];
      list.push({ name: acc.name || acc.id, cost, date: latest });
      byUnit.set(unit, list);
      seenDates.add(latest);
    }
    distinctDates = seenDates.size;
    const sections: Section[] = [...byUnit.entries()]
      .sort(([a], [b]) => unitOrder(a, b))
      .map(([unit, rows]) => ({ unit, rows: rows.sort((a, b) => b.cost - a.cost) }));
    return { sections, mixed: distinctDates > 1 };
  }, [accounts, statuses]);

  if (sections.length === 0) {
    return <ChartEmpty text="站点未返回费用（cost）统计，暂无法按账号对比" />;
  }

  return (
    <div className="cost-breakdown">
      <div className="cost-grid">
        {sections.map((sec) => (
          <div className="cost-section" key={sec.unit}>
            <p className="cost-cur-title">{sec.unit}</p>
            <ResponsiveContainer
              width="100%"
              height={Math.max(96, sec.rows.length * 34 + 20)}
              className="chart-box"
            >
              <BarChart data={sec.rows} layout="vertical" margin={{ top: 2, right: 72, bottom: 2, left: 0 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={110}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "currentColor" }}
                  tickFormatter={(s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s)}
                />
                <Tooltip content={<CostTip unit={sec.unit} />} cursor={{ fill: "var(--chart-cursor-fill)" }} />
                <Bar
                  dataKey="cost"
                  fill="var(--accent)"
                  radius={[0, 4, 4, 0]}
                  barSize={16}
                  isAnimationActive={!reducedMotion}
                  animationDuration={500}
                >
                  <LabelList dataKey="cost" content={renderCostValue} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
      <p className="chart-footnote">
        各账号取其最近一个有费用记录的日期{mixed ? "（账号间日期不一致，请留意）" : ""}；不同费用单位分节展示，不混合对比。
      </p>
    </div>
  );
}
