/**
 * MiniBars —— 紧凑柱状条（R15 设计系统原语，纯 CSS/div，无 recharts）
 *
 * 用途：卡片内嵌的逐日用量柱状趋势（比 MiniSparkline 更适合离散日粒度）。
 *
 * props 契约：
 * - data         数值序列（旧→新）。非有限数（NaN/Infinity）自动过滤；
 *                过滤后为空数组 → 虚线空态占位（emptyText）
 * - width        容器宽度 px，默认 96；非法值（<=0/NaN）回退默认
 * - height       容器高度 px，默认 28；非法值同上
 * - tone         柱色语义："accent"（默认）| "ok" | "warn" | "err"（复用 MiniSparkline 的 SparkTone）
 * - max          归一化上限，缺省用 data 最大值；传 <=0 / 非有限数时**忽略该参数**（回退 data 最大值），
 *                与 data 全为 0 的情况一起走「最小高度 + muted 灰」降级，不出现除零
 * - highlightLast 是否高亮最近一根（默认 true）；其余柱为同色 42% 透明版
 * - maxBars      最多渲染的柱数（默认 32，钳制 1–200）；超出只取**最近**的 N 根
 * - ariaLabel    读屏文本，默认 "紧凑柱状趋势"
 * - emptyText    空数组占位文案，默认 "暂无数据"
 * - className    追加类名
 *
 * 极端值降级：
 * - 空数组 / 全非有限数 → 虚线空态占位；
 * - 全为 0 或负数 → 每根保留 8% 最小可见高度并转为 muted 灰（示意「有数据但无用量」），不画负柱；
 * - 单点数据 → 一根满高柱；
 * - 柱数很多 → 自动收窄间距（>24 根时 gap 由 2px 降为 1px）并限流到 maxBars。
 *
 * 无障碍：容器 role="img" + aria-label（单柱不单独播报，避免读屏噪音）。
 */
import type { CSSProperties } from "react";
import type { SparkTone } from "./MiniSparkline";

export interface MiniBarsProps {
  data: readonly number[];
  width?: number;
  height?: number;
  tone?: SparkTone;
  max?: number;
  highlightLast?: boolean;
  maxBars?: number;
  ariaLabel?: string;
  emptyText?: string;
  className?: string;
}

const DEFAULT_W = 96;
const DEFAULT_H = 28;

function sane(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export default function MiniBars({
  data,
  width,
  height,
  tone = "accent",
  max,
  highlightLast = true,
  maxBars = 32,
  ariaLabel = "紧凑柱状趋势",
  emptyText = "暂无数据",
  className,
}: MiniBarsProps) {
  const w = sane(width, DEFAULT_W);
  const hgt = sane(height, DEFAULT_H);
  const cap = Number.isFinite(maxBars) ? Math.max(1, Math.min(200, Math.trunc(maxBars))) : 32;
  const cls = className ? ` ${className}` : "";

  const clean = (data ?? []).filter((v) => Number.isFinite(v));
  const bars = clean.length > cap ? clean.slice(clean.length - cap) : clean;

  if (bars.length === 0) {
    return (
      <span
        className={`mini-bars-empty${cls}`}
        style={{ minWidth: w, minHeight: hgt }}
        role="img"
        aria-label={`${ariaLabel}（${emptyText}）`}
      >
        {emptyText}
      </span>
    );
  }

  const peak = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : Math.max(...bars);
  const allNonPositive = bars.every((v) => v <= 0);
  const gap = bars.length > 24 ? 1 : 2;
  const style = { width: w, height: hgt, "--mini-gap": `${gap}px` } as CSSProperties;

  return (
    <div className={`mini-bars ${tone}${cls}`} style={style} role="img" aria-label={ariaLabel}>
      {bars.map((v, i) => {
        const ratio = peak > 0 ? Math.min(100, Math.max(0, (v / peak) * 100)) : 0;
        const zero = allNonPositive || v <= 0;
        const heightPct = zero ? 8 : Math.max(8, ratio);
        const last = highlightLast && i === bars.length - 1 ? " last" : "";
        return (
          <span
            key={i}
            className={`mini-bar${last}${zero ? " zero" : ""}`}
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </div>
  );
}
