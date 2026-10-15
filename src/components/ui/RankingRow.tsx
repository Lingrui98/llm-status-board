/**
 * RankingRow —— 排行行（R15 设计系统原语）
 *
 * 用途：账号/模型花费排行等「名次 + 名称 + 占比条 + 数值」的行。
 *
 * ⚠️ 语义容器：本组件渲染 <li>，请用 <ol className="rank-list">（或 ul）包裹整组，
 *    以获得「列表 / 第 N 项」的正确读屏语义（.rank-list 已在 styles.css 里重置了列表样式）。
 *
 * props 契约：
 * - rank      名次（1 起）。1–3 名徽标视觉突出；非正整数原样显示但不享受高亮
 * - name      名称。过长单行省略号截断，title 提示完整名称（可用 title 覆盖）
 * - value     number → 按 precision/unit 格式化；string → 原样显示；null/""/NaN → 显示「—」且不画条
 * - unit      数值后缀（如 "USD"），小一号灰色，不参与截断。**直接拼接到数值之后，不自动加空格**——
 *             要「30.00 USD」请传 unit=" USD"
 * - precision 小数位（number 时生效），默认 2；内部钳制 0–6
 * - max       归一化基准（一般是本组最大值，如 rows[0].value）。
 *             **不传 / <=0 / 非有限数时不填充轨道**——避免「人人满格」的误导；
 *             value > max 时按 100% 封顶；value <= 0 不画条（零值不画）
 * - tone      数值语义色 "default" | "ok" | "warn" | "err"（复用 StatTile 的 StatTone），默认 default。
 *             用于 round-15-plan §3.3「效率最差标红」等场景：同币种内 costPerRequest 最大者传 tone="err"；
 *             只给数值着色，单位后缀保持 muted，不影响名次徽标与占比条
 * - title     覆盖名称的 title 提示，缺省用 name
 * - className 追加类名
 *
 * 无障碍：名次徽标视觉显示数字、读屏播报「第 N 名」（sr-only）；
 * 占比条是纯装饰（aria-hidden），信息由数值文本承载。
 */
import type { StatTone } from "./StatTile";

export interface RankingRowProps {
  rank: number;
  name: string;
  value: number | string | null | undefined;
  unit?: string;
  precision?: number;
  max?: number;
  tone?: StatTone;
  title?: string;
  className?: string;
}

export default function RankingRow({
  rank,
  name,
  value,
  unit,
  precision = 2,
  max,
  tone = "default",
  title,
  className,
}: RankingRowProps) {
  const num = typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = typeof value === "string" ? value.trim() : "";
  const digits = Number.isFinite(precision) ? Math.max(0, Math.min(6, Math.trunc(precision))) : 2;
  const valueText = num !== null ? num.toFixed(digits) : str !== "" ? str : "—";

  const maxOk = typeof max === "number" && Number.isFinite(max) && max > 0;
  const pct = num !== null && num > 0 && maxOk ? Math.min(100, (num / max) * 100) : 0;

  const rankText = Number.isFinite(rank) ? String(Math.trunc(rank)) : "—";
  const top = Number.isFinite(rank) && rank >= 1 && rank <= 3 ? ` top${Math.trunc(rank)}` : "";

  return (
    <li className={`rank-row${className ? ` ${className}` : ""}`}>
      <span className={`rank-badge${top}`} aria-hidden="true">
        {rankText}
      </span>
      <span className="sr-only">第 {rankText} 名</span>
      <span className="rank-name" title={title ?? name}>
        {name}
      </span>
      <span className="rank-track" aria-hidden="true">
        <span className="rank-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className={`rank-value${tone === "default" ? "" : ` ${tone}`}`}>
        {valueText}
        {unit && valueText !== "—" && <span className="rank-unit">{unit}</span>}
      </span>
    </li>
  );
}
