/**
 * MiniSparkline —— 纯 SVG 迷你趋势线（R14 设计系统原语，无 recharts 依赖）
 *
 * 用途：在 StatTile 或表格行内展示一小段历史走势（如近 N 天余额/消耗）。
 *
 * props 契约：
 * - data       数值序列（旧→新）。空数组 / 全为非有限数 → 渲染虚线空态占位；
 *              单点 → 渲染一个圆点；min==max（如全部相同）→ 渲染水平直线（不除零）
 * - width      SVG 宽度 px，默认 96；非法值（<=0 / NaN）回退默认
 * - height     SVG 高度 px，默认 28；非法值同上
 * - tone       线条语义色："accent"（默认，中性走势）| "ok" | "warn" | "err"
 *              （「上升=好还是坏」因指标而异，不做自动判断，由调用方显式指定）
 * - fill       是否在线下方渲染淡色面积（默认 true），单点/空态时忽略
 * - ariaLabel  读屏文本（如 "近 7 天余额走势"），默认 "趋势图"
 * - emptyText  空态占位文案，默认 "数据不足"
 * - className  追加类名
 *
 * 色彩全部走 CSS（.spark-line.accent 等 → var(--accent)/--ok/--warn/--err），
 * 暗/亮主题自动跟随；组件无动画，天然符合 prefers-reduced-motion。
 */
export type SparkTone = "accent" | "ok" | "warn" | "err";

export interface MiniSparklineProps {
  data: readonly number[];
  width?: number;
  height?: number;
  tone?: SparkTone;
  fill?: boolean;
  ariaLabel?: string;
  emptyText?: string;
  className?: string;
}

const DEFAULT_W = 96;
const DEFAULT_H = 28;

function sane(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function MiniSparkline({
  data,
  width,
  height,
  tone = "accent",
  fill = true,
  ariaLabel = "趋势图",
  emptyText = "数据不足",
  className,
}: MiniSparklineProps) {
  const w = Math.round(sane(width, DEFAULT_W));
  const h = Math.round(sane(height, DEFAULT_H));
  const cls = className ? ` ${className}` : "";

  // 过滤 NaN / Infinity，保证后续几何计算不产出非法路径
  const clean = (data ?? []).filter((v) => Number.isFinite(v));

  if (clean.length === 0) {
    return (
      <span
        className={`spark-empty${cls}`}
        style={{ minWidth: w, minHeight: h }}
        role="img"
        aria-label={`${ariaLabel}（${emptyText}）`}
      >
        {emptyText}
      </span>
    );
  }

  const pad = 2; // 描边不贴边裁切
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const xOf = (i: number) =>
    clean.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (clean.length - 1);
  const yOf = (v: number) =>
    // span===0（全同值）时画中线，避免除零；y 轴向下，值越大越靠上
    span === 0 ? h / 2 : pad + ((max - v) / span) * (h - pad * 2);

  const pts = clean.map((v, i) => `${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`);
  const linePath = `M ${pts.join(" L ")}`;
  const areaPath =
    clean.length > 1
      ? `${linePath} L ${xOf(clean.length - 1).toFixed(2)},${h} L ${xOf(0).toFixed(2)},${h} Z`
      : null;

  return (
    <svg
      className={`spark${cls}`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={ariaLabel}
    >
      {areaPath && fill && <path className={`spark-fill ${tone}`} d={areaPath} />}
      {clean.length > 1 ? (
        <path className={`spark-line ${tone}`} d={linePath} />
      ) : (
        <circle className={`spark-dot ${tone}`} cx={w / 2} cy={h / 2} r={2.5} />
      )}
    </svg>
  );
}
