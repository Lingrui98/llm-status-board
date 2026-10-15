/**
 * SegmentedControl —— 分段切换器（R14 设计系统原语）
 *
 * 用途：少数互斥选项间切换（如洞察区「全局 / 按账号」口径）。
 *
 * props 契约（泛型 T 为选项值，默认 string）：
 * - options   选项数组：{ value, label, disabled?, title? }[]；空数组时组件渲染 null
 * - value     当前选中值（受控）；不在 options 中时全部不选中，用户点击后正常回调
 * - onChange  (value: T) => void；只有点击「未选中且未禁用」的选项才触发
 * - ariaLabel 整组的无障碍名称（如 "洞察口径"），默认 "分段选择"
 * - disabled  整组禁用
 * - className 追加类名
 *
 * 实现说明：底层是真实 radio input（.sr-only 视觉隐藏），
 * 键盘 Tab 聚焦 + 方向键切换为浏览器原生行为，无需额外 JS；
 * 选中态 / 焦点环样式在 styles.css 用 .checked 类与 :has(:focus-visible) 实现。
 */
import { useId } from "react";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export default function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel = "分段选择",
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const name = useId();

  if (options.length === 0) return null;

  return (
    <div
      className={`segmented${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const checked = opt.value === value;
        const optDisabled = disabled || !!opt.disabled;
        return (
          <label
            key={opt.value}
            className={`segmented-option${checked ? " checked" : ""}`}
            title={opt.title}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={opt.value}
              checked={checked}
              disabled={optDisabled}
              onChange={() => {
                if (!checked) onChange(opt.value);
              }}
            />
            <span className="segmented-text">{opt.label}</span>
          </label>
        );
      })}
    </div>
  );
}
