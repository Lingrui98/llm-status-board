import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** 是否开启「减弱动态效果」：recharts 的 JS 动画不受全局 CSS 媒体查询约束，需要组件层显式关闭 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** 图表空态占位：数据为空 / 数据点不足时替代空图；text 较长时自动换行居中 */
export function ChartEmpty({ height = 140, text = "暂无数据" }: { height?: number; text?: string }) {
  return (
    <div className="chart-empty" style={{ height }} role="img" aria-label={text}>
      <span className="chart-empty-note">{text}</span>
    </div>
  );
}

/** 卡片展开区里的图表小节（标题 + 内容） */
export function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chart-section">
      <h4 className="chart-title">{title}</h4>
      {children}
    </section>
  );
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 日期标签 MM-DD（容忍 "2026-10-10" / ISO / 其他字符串） */
export function dayLabel(date: string): string {
  const m = date.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const d = new Date(date);
  if (isNaN(d.getTime())) return date;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 时间标签 MM-DD HH:mm（余额趋势 x 轴） */
export function tsLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
