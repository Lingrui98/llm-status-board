/**
 * HeatStrip —— 近 N 天热力条（R15 设计系统原语，纯 CSS/div）
 *
 * 用途：分析视图里一行查看近 N 天的用量/花费强度分布。
 *
 * props 契约：
 * - cells      { label, value, level?, title? }[]，旧→新（左→右）
 *              label：格子名（日期等），用于读屏与默认提示；value：数值，null/NaN → 无数据格
 *              level：显式分档 0–levels（0 = 无数据/零值）；缺省按分位排名自动分级
 *              title：覆盖默认提示文案（默认「label：value unit」）
 * - levels     强度档位数（1–8），默认 4。level 0 恒为「无数据/零值」轨道色，1..levels 为强度渐变
 * - unit       数值后缀（如 "USD"）。**直接拼接到数值之后，不自动加空格**——
 *              提示里要「12.34 USD」请传 unit=" USD"；格子 aria-label 与气泡文案同此规则
 * - height     格子高度 px，默认 22；非法值回退 22
 * - precision  数值小数位，默认 2；内部钳制 0–6
 * - ariaLabel  整组无障碍名（默认 "近 N 天热力条"）
 * - emptyText  空数组占位文案，默认 "暂无数据"
 * - onSelect   可选点击回调（传 index）；不传时格子仍是可聚焦的提示目标，点击无副作用
 * - className  追加类名
 *
 * 自动分级：按**分位排名**（percentile rank）分档，天然抗离群值（不同于 min-max 归一化）；
 * 全部等值时同档，不产生误导性差异。非正数（0/负数）恒为 0 档。
 *
 * 无障碍：容器 role="group" + aria-label；格子是真实 <button>，采用**游标 tabindex**——
 * 整条只占 1 个 Tab 停靠点，进入后用 ←/→/↑/↓/Home/End 移动焦点（focus 环由全局 :focus-visible 提供）；
 * 悬停或键盘聚焦都会显示数值气泡（.heat-tip），格子自身 aria-label 供读屏播报。
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface HeatStripCell {
  label: string;
  value: number | null | undefined;
  level?: number;
  title?: string;
}

export interface HeatStripProps {
  cells: readonly HeatStripCell[];
  levels?: number;
  unit?: string;
  height?: number;
  precision?: number;
  ariaLabel?: string;
  emptyText?: string;
  onSelect?: (index: number) => void;
  className?: string;
}

export default function HeatStrip({
  cells,
  levels = 4,
  unit,
  height = 22,
  precision = 2,
  ariaLabel = "近 N 天热力条",
  emptyText = "暂无数据",
  onSelect,
  className,
}: HeatStripProps) {
  const items = cells ?? [];
  const buckets = Number.isFinite(levels) ? Math.max(1, Math.min(8, Math.trunc(levels))) : 4;
  const digits = Number.isFinite(precision) ? Math.max(0, Math.min(6, Math.trunc(precision))) : 2;
  const h = Number.isFinite(height) && height > 0 ? Math.round(height) : 22;
  const cls = className ? ` ${className}` : "";

  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // cells 变短时把游标收回范围内，避免 tabIndex 指向已消失的格子
  useEffect(() => {
    if (active > items.length - 1) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  // 自动分级基准：只统计正数（0/负数/非有限数不进分位）
  const positives = items
    .map((c) => (typeof c.value === "number" && Number.isFinite(c.value) && c.value > 0 ? c.value : null))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const autoLevel = (v: number): number => {
    if (positives.length === 0) return 1;
    let notGreater = 0;
    for (const p of positives) if (p <= v) notGreater += 1;
    return Math.max(1, Math.min(buckets, Math.ceil((notGreater / positives.length) * buckets)));
  };

  const fmt = (v: number) => `${v.toFixed(digits)}${unit ?? ""}`;

  if (items.length === 0) {
    return (
      <span className={`heat-empty${cls}`} role="img" aria-label={`${ariaLabel}（${emptyText}）`}>
        {emptyText}
      </span>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = items.length;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(n - 1, active + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, active - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };

  return (
    <div className={`heat-strip${cls}`} role="group" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {items.map((c, i) => {
        const value: number | null =
          typeof c.value === "number" && Number.isFinite(c.value) ? c.value : null;
        const level =
          typeof c.level === "number" && Number.isFinite(c.level)
            ? Math.max(0, Math.min(buckets, Math.trunc(c.level)))
            : value === null || value <= 0
              ? 0
              : autoLevel(value);
        const tip = c.title ?? `${c.label}：${value === null ? "无数据" : fmt(value)}`;
        return (
          <button
            key={`${c.label}-${i}`}
            type="button"
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={`heat-cell lv-${level}`}
            style={{ height: h }}
            tabIndex={i === active ? 0 : -1}
            aria-label={tip}
            onFocus={() => setActive(i)}
            onClick={() => onSelect?.(i)}
          >
            <span className="heat-tip" aria-hidden="true">
              {tip}
            </span>
          </button>
        );
      })}
    </div>
  );
}
