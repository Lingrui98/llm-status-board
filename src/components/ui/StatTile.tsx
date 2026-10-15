/**
 * StatTile —— 洞察区指标磁贴（R14 设计系统原语）
 *
 * 用途：展示单个洞察指标（日均消耗 / 可支撑天数 / 预计支出等），
 * 结构为「小标签 + 大数字(+单位) + 辅助说明」，可带趋势箭头与风险色。
 *
 * props 契约：
 * - label      指标名（小字标签，如 "日均消耗"）
 * - value      已格式化的数值文本；传 null / undefined / "" 时自动降级为占位符 "—"
 *              （格式化请由调用方用 src/format.ts 完成，本组件保持纯展示、不做币种判断）
 * - unit       单位后缀（如 "天" / "%" / "USD"），小一号灰色排版，跟随大数字基线
 * - hint       辅助说明（如 "近 7 天窗口"），muted 小字
 * - tone       大数字语义色："default" | "ok" | "warn" | "err"（复用全局语义色，默认 default）
 * - trend      趋势箭头方向："up" | "down" | "flat"；不传则不渲染箭头
 * - trendTone  箭头语义色（上升不一定是好事，由调用方按业务判断，默认 default=灰）
 * - trendLabel 箭头旁文字（如 "+12%"），可选
 * - children   可选底部插槽，通常放 <MiniSparkline />
 * - className  追加类名（集成方做布局微调用）
 *
 * 视觉与 .card / .balance-value 同源：渐变卡面、27px→22px 数字层级、tabular-nums。
 */
import type { ReactNode } from "react";

export type StatTone = "default" | "ok" | "warn" | "err";
export type TrendDirection = "up" | "down" | "flat";

export interface StatTileProps {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  hint?: string;
  tone?: StatTone;
  trend?: TrendDirection | null;
  trendTone?: StatTone;
  trendLabel?: string;
  children?: ReactNode;
  className?: string;
}

const TREND_GLYPH: Record<TrendDirection, string> = {
  up: "↑",
  down: "↓",
  flat: "→",
};

function toneClass(base: string, tone: StatTone): string {
  return tone === "default" ? base : `${base} ${tone}`;
}

export default function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "default",
  trend = null,
  trendTone = "default",
  trendLabel,
  children,
  className,
}: StatTileProps) {
  const empty = value === null || value === undefined || value === "";
  const text = empty ? "—" : String(value);

  return (
    <div className={`stat-tile${className ? ` ${className}` : ""}`}>
      <div className="stat-tile-head">
        <span className="stat-tile-label">{label}</span>
        {trend && (
          <span className={toneClass("stat-tile-trend", trendTone)}>
            <span aria-hidden="true">{TREND_GLYPH[trend]}</span>
            {trendLabel && <span>{trendLabel}</span>}
          </span>
        )}
      </div>
      <div className="stat-tile-body">
        <span
          className={`${toneClass("stat-tile-value", tone)}${empty ? " placeholder" : ""}`}
        >
          {text}
        </span>
        {unit && !empty && <span className="stat-tile-unit">{unit}</span>}
      </div>
      {hint && <span className="stat-tile-hint">{hint}</span>}
      {children && <div className="stat-tile-extra">{children}</div>}
    </div>
  );
}
