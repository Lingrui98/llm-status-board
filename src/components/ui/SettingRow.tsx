/**
 * SettingRow —— 统一设置行（R16 设计系统原语）
 *
 * 用途：设置页「常驻与通知」等分组里的单行设置：左侧标签(+辅助说明)、右侧状态徽标 + 控件槽。
 * 可容纳开关 / 下拉 / 按钮 / 自定义控件（本仓已有 ThresholdSlider 等原语）。
 *
 * props 契约：
 * - label      设置名（左侧主文案）。超长时单行省略号截断，title 提示完整文案
 * - hint       可选辅助说明（label 下方），muted 小字；超长最多显示 2 行并截断，title 提示全文
 * - control    右侧控件槽：
 *              · ReactNode —— 原样渲染。**请让控件自带无障碍名**（aria-label），
 *                或同时传 htmlFor 指向控件的 id（此时 label 是真正的 <label htmlFor>）
 *              · (a11y) => ReactNode —— 推荐写法：组件把 id/describedBy/disabled 交给你，
 *                label 与 hint 自动完成关联，无需手工维护 id：
 *                `control={(a) => <input id={a.id} aria-describedby={a.describedBy} disabled={a.disabled} />}`
 * - htmlFor    控件 id（简单路径用，需与控件 id 一致）。传了它 label 才会渲染为 <label htmlFor>
 * - badge      可选状态徽标内容（如「已开启」「未授权」）；字符串或节点均可，统一套 .set-row-badge 药丸样式
 * - badgeTone  徽标语义色 "default" | "ok" | "warn" | "err"（复用 StatTile 的 StatTone），默认 default
 * - disabled   禁用态：整行 45% 透明（同 .disabled-row）+ 根节点 aria-disabled。
 *              **控件本身仍需调用方禁用**（渲染函数路径可用 a11y.disabled 直接透传）
 * - title      覆盖 label 的原生提示（默认用 label 文案）
 * - className  追加类名
 *
 * 槽内原生控件样式（免手工）：
 * - `.set-row-control` 的**直接子元素** input（非 checkbox）/ select 会自动套用设计系统控件质感
 *   （同 .setting-row input / .help-select）；若控件被额外包了一层，请给控件加
 *   className="set-input" / "set-select"。
 * - 开关用既有 `className="switch"`；滑块/分段切换用既有原语即可，互不干扰。
 *
 * 分组容器：沿用既有 `.settings-section` + `<h3>`（与其它设置分组视觉一致）；
 * 多行可用可选的 `.set-rows` 竖排（行自带 7px 上下内边距，无需额外 gap）。
 *
 * 为什么用显式 htmlFor 而不是把控件包进 <label>：本行右侧可能放按钮（如「去授权」），
 * 包裹式 label 会让「点标签文字」误触发按钮。显式关联对开关/滑块/下拉同样有效且无此副作用。
 *
 * 布局与既有 .setting-row 保持同一节奏（padding 7px 0 / gap 14px / 13px），
 * 但使用独立类名（.set-row）以免被既有 `.setting-row input:not([type=checkbox])` 选择器波及
 * 嵌套控件（如 ThresholdSlider 的数字框）。
 */
import { useId } from "react";
import type { ReactNode } from "react";
import type { StatTone } from "./StatTile";

export interface SettingRowA11y {
  /** 应传给控件的 id（与 label 的 htmlFor 同值） */
  id: string;
  /** 有 hint 时应传给控件的 aria-describedby（无 hint 为 undefined） */
  describedBy: string | undefined;
  /** 与组件 disabled 同值，便于直接透传给控件 */
  disabled: boolean;
}

export interface SettingRowProps {
  label: string;
  hint?: string;
  control?: ReactNode | ((a11y: SettingRowA11y) => ReactNode);
  htmlFor?: string;
  badge?: ReactNode;
  badgeTone?: StatTone;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export default function SettingRow({
  label,
  hint,
  control,
  htmlFor,
  badge,
  badgeTone = "default",
  disabled = false,
  title,
  className,
}: SettingRowProps) {
  const autoId = useId();
  const controlId = htmlFor ?? autoId;
  const hintId = `${autoId}-hint`;

  const a11y: SettingRowA11y = {
    id: controlId,
    describedBy: hint ? hintId : undefined,
    disabled,
  };
  const isRenderProp = typeof control === "function";
  const node = isRenderProp ? (control as (a: SettingRowA11y) => ReactNode)(a11y) : control;
  const labelFor = htmlFor !== undefined || isRenderProp;
  const showBadge = badge !== undefined && badge !== null && badge !== false;

  const cls = `set-row${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`;

  return (
    <div className={cls} aria-disabled={disabled || undefined}>
      <div className="set-row-main">
        {labelFor ? (
          <label className="set-row-label" htmlFor={controlId} title={title ?? label}>
            {label}
          </label>
        ) : (
          <span className="set-row-label" title={title ?? label}>
            {label}
          </span>
        )}
        {hint && (
          <span className="set-row-hint" id={hintId} title={hint}>
            {hint}
          </span>
        )}
      </div>
      <div className="set-row-side">
        {showBadge && (
          <span className={`set-row-badge${badgeTone === "default" ? "" : ` ${badgeTone}`}`}>
            {badge}
          </span>
        )}
        <div className="set-row-control">{node}</div>
      </div>
    </div>
  );
}
