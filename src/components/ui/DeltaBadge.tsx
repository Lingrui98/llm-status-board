/**
 * DeltaBadge —— 涨跌变化徽标（R15 设计系统原语）
 *
 * 用途：分析视图里展示某个指标相对基准（昨日/上周/上月）的变化量。
 *
 * props 契约：
 * - value      number → 组件按 precision/unit 自动格式化并加正负号；string → 原样显示（调用方已格式化）
 *              null / undefined / "" / 非有限数 → 降级为「—」占位（tone 强制中性、不显示箭头）
 *              **绝不出现 "+0%"**：四舍五入后为 0 时只显示 "0"，方向按 flat 处理
 * - direction  "up" | "down" | "flat"；缺省按 value 符号推断（0 → flat）
 * - tone       语义色 "default" | "ok" | "warn" | "err"（复用 StatTile 的 StatTone）。
 *              **「上涨是好是坏」由调用方决定**：花费上涨应传 tone="err"、余额上涨传 tone="ok"；
 *              本组件不做业务判断，只负责着色
 * - precision  小数位（number 时生效），默认 1；非法值回退 1，内部钳制 0–6
 * - unit       数值后缀，默认 "%"；传 "" 表示无单位。**直接拼接到数值之后，不自动加空格**
 *              （如 "+3 次" 需传 unit=" 次"、"+12 USD" 需传 unit=" USD"）
 * - label      前缀说明（如 "较昨日"）
 * - title      原生 hover 提示（如同比口径说明）
 * - className  追加类名
 *
 * 无障碍：箭头 aria-hidden，方向以 sr-only 文本播报（上升/下降/持平），
 * 读屏结果为「较昨日 上升 12.3%」。
 */
import type { StatTone, TrendDirection } from "./StatTile";

export interface DeltaBadgeProps {
  value: number | string | null | undefined;
  direction?: TrendDirection;
  tone?: StatTone;
  precision?: number;
  unit?: string;
  label?: string;
  title?: string;
  className?: string;
}

const GLYPH: Record<TrendDirection, string> = { up: "↑", down: "↓", flat: "→" };
const WORD: Record<TrendDirection, string> = { up: "上升", down: "下降", flat: "持平" };

export default function DeltaBadge({
  value,
  direction,
  tone = "default",
  precision = 1,
  unit = "%",
  label,
  title,
  className,
}: DeltaBadgeProps) {
  const num = typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = typeof value === "string" ? value.trim() : "";
  const empty = num === null && str === "";
  const digits = Number.isFinite(precision) ? Math.max(0, Math.min(6, Math.trunc(precision))) : 1;

  let text: string;
  let dir: TrendDirection;
  if (empty) {
    text = "—";
    dir = "flat";
  } else if (num === null) {
    text = str;
    dir = direction ?? "flat";
  } else {
    const shown = Number(num.toFixed(digits)); // 先四舍五入：0.04 → 0，避免 "+0.0%"
    dir = direction ?? (shown > 0 ? "up" : shown < 0 ? "down" : "flat");
    text = shown === 0 ? `0${unit}` : `${shown > 0 ? "+" : ""}${shown.toFixed(digits)}${unit}`;
  }

  const cls = `delta-badge${empty ? " placeholder" : tone === "default" ? "" : ` ${tone}`}${
    className ? ` ${className}` : ""
  }`;

  return (
    <span className={cls} title={title}>
      {label && <span className="delta-label">{label}</span>}
      {!empty && <span className="sr-only">{WORD[dir]}</span>}
      {!empty && (
        <span className="delta-glyph" aria-hidden="true">
          {GLYPH[dir]}
        </span>
      )}
      <span className="delta-value">{text}</span>
    </span>
  );
}
