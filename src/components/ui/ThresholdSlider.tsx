/**
 * ThresholdSlider —— 阈值设置控件（R14 设计系统原语）
 *
 * 用途：告警阈值配置（余额阈值 USD/CNY、配额百分比等），滑块与数字输入双向联动。
 *
 * props 契约：
 * - label     控件名称（同时作为滑块的 aria-label 与数字输入的 label）
 * - value     当前值（受控）。**展示口径 = 真实值**：合法但超出 [min, max] 的值仍在数字输入框中
 *             如实显示（只有滑块几何位置停在最近边界），渲染阶段绝不回写配置，
 *             避免静默改写用户配置（R14 终审 D-4）；非有限数回退为 min。
 *             仅当用户主动拖动滑块 / 提交数字框时才回调「钳制 + 步进对齐」后的值，
 *             因此 onChange 永远不会收到 NaN 或越界值
 * - min, max  取值范围（传反了会自动交换）；min===max 时滑块禁用态显示但不报错
 * - step      步进，默认 1；非法值（<=0 / NaN）回退 1。滑块值与手动输入提交时都会对齐到步进
 * - unit      单位后缀（如 "USD" / "%"），显示在数字输入框右侧
 * - hint      辅助说明（如 "低于该余额时通知"），标签行右侧 muted 小字
 * - disabled  整体禁用（滑块 + 输入框 + 视觉 45% 透明，与 .disabled-row 一致）
 * - id        可选手动指定 id 前缀（默认用 useId 生成，保证多实例不冲突）
 * - onChange  (value: number) => void；值未实际变化时不会触发（避免受控死循环）
 * - className 追加类名
 *
 * 交互细节：数字输入框打字过程中不打扰，失焦或 Enter 才提交（钳制 + 对齐步进）；
 * 输入非法文本则回退为当前值。滑块轨道填充比例通过 CSS 变量 --ts-fill 驱动。
 */
import { useEffect, useId, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

export interface ThresholdSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: number) => void;
  className?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 对齐到步进网格，并按步进小数位取整消除浮点误差（如 0.1 步进出现 5.000000001） */
function snap(v: number, lo: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  const snapped = lo + Math.round((v - lo) / step) * step;
  return Number(snapped.toFixed(Math.min(decimals, 6)));
}

export default function ThresholdSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  disabled = false,
  id,
  onChange,
  className,
}: ThresholdSliderProps) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const rangeId = `${baseId}-range`;
  const numberId = `${baseId}-number`;
  const noticeId = `${baseId}-notice`;

  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const st = typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 1;
  // 真实值（展示口径）与滑块位置（几何口径）分开：
  // 滑块必须落在 [lo, hi] 内，但**数字输入必须显示真实配置值** ——
  // 若拿 clamp 后的值当展示值，配置里一个合法但超出滑块量程的值会被显示成上界，
  // 用户一拖动就把真实值静默改写掉（R14 终审 D-4）。
  const displayValue = Number.isFinite(value) ? value : lo;
  const current = clamp(displayValue, lo, hi);
  const outOfRange = displayValue < lo || displayValue > hi;
  const fillPct = hi === lo ? 100 : ((current - lo) / (hi - lo)) * 100;

  // 数字输入的本地文本：外部 value 变化（含滑块拖动）时同步；打字期间以本地为准
  const [text, setText] = useState(String(displayValue));
  useEffect(() => {
    setText(String(displayValue));
  }, [displayValue]);

  const emit = (next: number) => {
    if (next !== displayValue) onChange(next);
  };

  const commitText = () => {
    // D-8：用户没改文本就不提交。否则「Tab 进 → 不输入 → Tab 出」会把超量程的真实值
    // （如 50000，滑块量程 0..10000）clamp 后回写，静默改写既有配置。
    if (text.trim() === String(displayValue)) return;
    const parsed = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      setText(String(displayValue)); // 非法输入回退
      return;
    }
    const next = clamp(snap(parsed, lo, st), lo, hi);
    setText(String(next));
    emit(next);
  };

  const onNumberKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      commitText();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setText(String(displayValue));
      e.currentTarget.blur();
    }
  };

  const fillStyle = { "--ts-fill": `${fillPct}%` } as CSSProperties;

  return (
    <div
      className={`threshold${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="threshold-head">
        <label className="threshold-label" htmlFor={numberId}>
          {label}
        </label>
        {hint && <span className="threshold-hint">{hint}</span>}
      </div>
      <div className="threshold-controls">
        <input
          type="range"
          className="threshold-range"
          id={rangeId}
          aria-label={label}
          aria-describedby={outOfRange ? noticeId : undefined}
          min={lo}
          max={hi}
          step={st}
          value={current}
          disabled={disabled || hi === lo}
          style={fillStyle}
          onChange={(e) => emit(clamp(Number(e.target.value), lo, hi))}
        />
        <div className="threshold-field">
          <input
            type="number"
            className="threshold-number"
            id={numberId}
            aria-describedby={outOfRange ? noticeId : undefined}
            min={lo}
            max={hi}
            step={st}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={onNumberKeyDown}
          />
          {unit && <span className="threshold-unit">{unit}</span>}
        </div>
      </div>
      {/* 真实值超出滑块量程时如实告知：数字框仍是真实值，滑块只停在上界（D-4）。
          role="status"（polite live region）让提示出现时读屏可感知；
          两个输入控件通过 aria-describedby 关联本提示。（文案被 ThresholdSlider.test.tsx 断言，勿改） */}
      {outOfRange && (
        <span id={noticeId} className="threshold-notice" role="status">
          当前值 {displayValue} 超出滑块范围 {lo}–{hi}，滑块已停在上/下界；数值本身未被修改。
        </span>
      )}
    </div>
  );
}
