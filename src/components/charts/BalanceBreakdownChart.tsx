import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { AccountInfo } from "../../types";
import { formatDecimal } from "../../format";
import { ChartEmpty, usePrefersReducedMotion } from "./shared";

interface Props {
  info?: AccountInfo | null;
  /** 空数据时的具体原因说明 */
  emptyNote?: string;
}

/** 环形图分段（value 已保证非负；display 为 tooltip/图例用的预格式化文本） */
interface Slice {
  name: string;
  value: number;
  display: string;
  color: string;
  /** 已用/剩余轨道段的弱化透明度 */
  faded?: boolean;
}

interface Breakdown {
  mode: "amount" | "window";
  slices: Slice[];
  /** 中心大数字（如 "68%"） */
  centerPct: string;
  /** 中心副文本（如 "剩余 68.00 USD" / "5h 窗口"） */
  centerSub: string;
  /** aria-label 汇总 */
  summary: string;
}

/** 中性段（已用/未用轨道）：跟随主题的灰蓝，弱化透明度 */
const NEUTRAL = "var(--text-3)";
/** 剩余段：绿系（--ok），暗/亮两模式自动换色 */
const REMAIN = "var(--ok)";

function levelColor(pct: number): string {
  if (pct > 80) return "var(--err)";
  if (pct >= 60) return "var(--warn)";
  return "var(--ok)";
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: Slice }>;
}

function BreakdownTip({ active, payload }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const s = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tt-row">
        <span>
          <i className="tt-swatch" style={{ background: s.color }} />
          {s.name}
        </span>
        <b>{s.display}</b>
      </div>
    </div>
  );
}

/**
 * 额度构成环形图（单个账号）：
 * - 有总额度时：剩余（绿）vs 已用（中性灰）双段 donut，中心显示剩余百分比；
 * - 仅配额窗口（订阅模式）时：取用量最高的窗口画单段进度环，中心显示已用百分比；
 * - 两者皆无：空态说明。
 */
export default function BalanceBreakdownChart({ info, emptyNote }: Props) {
  const reducedMotion = usePrefersReducedMotion();

  const data = useMemo<Breakdown | null>(() => {
    if (!info) return null;
    const totalAmt = info.total?.amount;
    if (totalAmt !== null && totalAmt !== undefined && totalAmt > 0) {
      const currency = info.total?.currency ?? info.balance?.currency ?? info.used?.currency ?? "";
      const bal = info.balance?.amount;
      const usedRaw = info.used?.amount;
      // 已用优先取 used，缺省用 total - balance 推；剩余反之
      let usedAmt: number | null = null;
      let remainAmt: number | null = null;
      if (usedRaw !== null && usedRaw !== undefined) usedAmt = Math.max(0, usedRaw);
      if (bal !== null && bal !== undefined) remainAmt = Math.max(0, bal);
      if (usedAmt === null && remainAmt !== null) usedAmt = Math.max(0, totalAmt - remainAmt);
      if (remainAmt === null && usedAmt !== null) remainAmt = Math.max(0, totalAmt - usedAmt);
      if (usedAmt !== null && remainAmt !== null) {
        // 超用/数据不齐时按比例归一，保证环形闭合
        const sum = usedAmt + remainAmt;
        const scale = sum > totalAmt && sum > 0 ? totalAmt / sum : 1;
        const used = usedAmt * scale;
        const remain = remainAmt * scale;
        const pct = totalAmt > 0 ? (remain / totalAmt) * 100 : 0;
        return {
          mode: "amount",
          slices: [
            {
              name: "剩余",
              value: remain,
              display: `${formatDecimal(remainAmt)} ${currency}`.trim(),
              color: REMAIN,
            },
            {
              name: "已用",
              value: used,
              display: `${formatDecimal(usedAmt)} ${currency}`.trim(),
              color: NEUTRAL,
              faded: true,
            },
          ],
          centerPct: `${pct.toFixed(0)}%`,
          centerSub: `剩余 ${formatDecimal(remainAmt)} ${currency}`.trim(),
          summary: `额度剩余 ${pct.toFixed(0)}%，剩余 ${formatDecimal(remainAmt)} ${currency}，已用 ${formatDecimal(usedAmt)} ${currency}`,
        };
      }
    }

    // 订阅/窗口模式：取用量百分比最高的窗口画进度环
    const win = (info.quotaWindows ?? [])
      .filter((w) => !!w && typeof w.usedPercent === "number" && !Number.isNaN(w.usedPercent))
      .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    if (win && win.usedPercent !== null && win.usedPercent !== undefined) {
      const pct = Math.min(100, Math.max(0, win.usedPercent));
      const name = win.window ?? "配额窗口";
      return {
        mode: "window",
        slices: [
          { name: "已用", value: pct, display: `${pct.toFixed(0)}%`, color: levelColor(pct) },
          { name: "剩余", value: 100 - pct, display: `${(100 - pct).toFixed(0)}%`, color: NEUTRAL, faded: true },
        ],
        centerPct: `${pct.toFixed(0)}%`,
        centerSub: name,
        summary: `${name} 已用 ${pct.toFixed(0)}%`,
      };
    }
    return null;
  }, [info]);

  if (!data) return <ChartEmpty text={emptyNote ?? "该账号没有可视化的额度构成数据"} />;

  return (
    <div role="img" aria-label={data.summary}>
      <div className="donut-wrap">
        <ResponsiveContainer width="100%" height={190} className="chart-box">
          <PieChart>
            <Tooltip content={<BreakdownTip />} />
            <Pie
              data={data.slices}
              dataKey="value"
              nameKey="name"
              innerRadius="66%"
              outerRadius="88%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={data.mode === "amount" ? 3 : 0}
              cornerRadius={data.mode === "amount" ? 5 : 0}
              stroke="none"
              isAnimationActive={!reducedMotion}
            >
              {data.slices.map((s) => (
                <Cell key={s.name} fill={s.color} fillOpacity={s.faded ? 0.42 : 1} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center" aria-hidden="true">
          <span className="donut-pct">{data.centerPct}</span>
          <span className="donut-sub">{data.centerSub}</span>
        </div>
      </div>
      {data.mode === "amount" && (
        <div className="donut-legend">
          {data.slices.map((s) => (
            <div className="donut-legend-row" key={s.name}>
              <span>
                <i className="donut-dot" style={{ background: s.color, opacity: s.faded ? 0.42 : 1 }} />
                {s.name}
              </span>
              <b>{s.display}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
