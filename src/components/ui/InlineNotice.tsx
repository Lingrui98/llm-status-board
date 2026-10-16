/**
 * InlineNotice —— 应用内轻量提示条（R16 设计系统原语）
 *
 * 用途：非阻断提示。如「通知权限被拒」「开机自启设置失败」「用量历史写入失败」。
 * 与阻断式弹窗相反：不抢焦点、不挡操作，正文自动换行（提示必须可读，不做截断）。
 *
 * props 契约：
 * - tone         "info"（默认）| "warn" | "err"。决定语义色与 live region 角色：
 *                **err → role="alert" + aria-live="assertive"**；
 *                **info/warn → role="status" + aria-live="polite"**（aria-atomic 全量播报）
 * - live         覆盖 live 播报强度："polite"（默认，按 tone 推导）| "assertive" | "off"。
 *                **逐秒变化的文本必须传 live="off"**（如 round-16-plan §5 的「Ns 后重试」倒计时）：
 *                否则 polite + aria-atomic 会让读屏每秒播报一次。live="off" 时容器不再带
 *                live region 角色（role 也不设），状态变化请另用 sr-only 的 role="status" 播报一次
 *                （App.tsx 已有该模式）。
 * - message      正文纯文本（与 children 二选一，children 优先）
 * - children     富文本正文（含链接等）；优先于 message
 * - title        可选加粗标题（如「通知权限被拒」）
 * - action       可选操作按钮：{ label, onClick, disabled?, title? }（如「去授权」「重试」）
 * - onDismiss    传了才渲染右上「×」关闭按钮；**仅在用户点击关闭时回调**（自动消退不回调）
 * - dismissLabel 关闭按钮无障碍名，默认「关闭提示」
 * - autoHideMs   自动消退毫秒数。**不传＝常驻（默认）**；
 *                · 内部有 4000ms 下限（防止「来不及读」，传更小值会被抬到 4s）
 *                · **err 一律忽略该参数**——错误提示不得自动消失（否则用户永远看不到「去授权」）
 *                · 鼠标悬停 或 键盘聚焦到条内任一元素（含操作/关闭按钮）→ 暂停计时，离开后按剩余时间继续
 *                · 消退用 180ms 淡出；**prefers-reduced-motion 下不淡出**——组件直接 0ms 卸载
 *                  （既不淡出，也不留「透明但仍占位」的空档），CSS 侧同时有全局降级规则兜底
 * - className    追加类名
 *
 * 状态复用：同一实例上 message / tone / autoHideMs 变化视为「新提示」，会重置计时并重新显示；
 * 若父级用同一实例连续推不同提示而不改 message，请改用 key 强制重建。
 *
 * 视觉：与既有 .insights-notice / .threshold-notice 同一套 soft 语义色配方
 * （info = --bg-1 60% + --border + --text-2；warn/err = --*-soft 底 + 35% 同色描边 + 同色文字），
 * 不引入第三种警示样式。
 */
import { useEffect, useRef, useState } from "react";
import type { FocusEvent, ReactNode } from "react";

export type NoticeTone = "info" | "warn" | "err";
export type NoticeLive = "off" | "polite" | "assertive";

export interface InlineNoticeAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export interface InlineNoticeProps {
  tone?: NoticeTone;
  live?: NoticeLive;
  message?: string;
  children?: ReactNode;
  title?: string;
  action?: InlineNoticeAction;
  onDismiss?: () => void;
  dismissLabel?: string;
  autoHideMs?: number;
  className?: string;
}

/** 自动消退下限：提示类文案的阅读时间不能被调用方压到「来不及读」 */
const MIN_AUTO_HIDE_MS = 4000;
/** 淡出时长（reduced-motion 下直接为 0，不做淡出） */
const FADE_MS = 180;

/** 用户是否要求减弱动效。守卫 matchMedia 存在性：jsdom 等环境没有它，不能因此抛错 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function InlineNotice({
  tone = "info",
  live,
  message,
  children,
  title,
  action,
  onDismiss,
  dismissLabel = "关闭提示",
  autoHideMs,
  className,
}: InlineNoticeProps) {
  const autoHideMsNum =
    typeof autoHideMs === "number" && Number.isFinite(autoHideMs) && autoHideMs > 0 ? autoHideMs : 0;
  const autoHide = tone !== "err" && autoHideMsNum > 0; // err 永不自动消退
  const delay = autoHide ? Math.max(MIN_AUTO_HIDE_MS, Math.trunc(autoHideMsNum)) : 0;

  const [gone, setGone] = useState(false);
  const [closing, setClosing] = useState(false);
  const [held, setHeld] = useState(false);
  const remaining = useRef(delay);
  const dismissedByUser = useRef(false);

  // onDismiss 用 ref 持有：避免父级每次渲染换函数导致淡出计时被重置
  const dismissCb = useRef(onDismiss);
  useEffect(() => {
    dismissCb.current = onDismiss;
  }, [onDismiss]);

  // 新提示（message/tone/延迟变化）→ 重置计时与显示状态
  useEffect(() => {
    remaining.current = delay;
    dismissedByUser.current = false;
    setGone(false);
    setClosing(false);
    setHeld(false);
  }, [message, tone, delay]);

  // 消退计时：悬停保持/依赖变化/卸载时把「已流逝时间」从剩余额度里扣掉，恢复时继续用剩余额度
  useEffect(() => {
    if (!autoHide || held || closing || gone) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      remaining.current = 0;
      setClosing(true);
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [autoHide, held, closing, gone, message, delay]);

  // 淡出结束后卸载；若是用户主动关闭，再回调 onDismiss。
  // reduced-motion 下不淡出：直接 0ms 卸载（不留「透明但仍占位」的 180ms）
  useEffect(() => {
    if (!closing) return;
    const fadeMs = prefersReducedMotion() ? 0 : FADE_MS;
    const fade = window.setTimeout(() => {
      setGone(true);
      if (dismissedByUser.current) {
        dismissedByUser.current = false;
        dismissCb.current?.();
      }
    }, fadeMs);
    return () => window.clearTimeout(fade);
  }, [closing]);

  if (gone) return null;

  const isErr = tone === "err";
  const resolvedLive: NoticeLive = live ?? (isErr ? "assertive" : "polite");
  // live="off"：不设 live region 角色，确保高频更新的文本（如逐秒倒计时）不被读屏反复播报
  const liveRole: "alert" | "status" | undefined =
    resolvedLive === "off" ? undefined : isErr ? "alert" : "status";
  const cls = `inline-notice${tone === "info" ? "" : ` ${tone}`}${
    closing ? " closing" : ""
  }${className ? ` ${className}` : ""}`;

  // 焦点仍在条内（从一个控件移到另一个）时不恢复计时
  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setHeld(false);
  };

  return (
    <div
      className={cls}
      role={liveRole}
      aria-live={resolvedLive}
      aria-atomic="true"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={handleBlur}
    >
      <div className="inline-notice-body">
        {title && <span className="inline-notice-title">{title}</span>}
        <span className="inline-notice-text">{children ?? message}</span>
      </div>
      <div className="inline-notice-actions">
        {action && (
          <button
            type="button"
            className="inline-notice-action"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
          >
            {action.label}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="inline-notice-close"
            aria-label={dismissLabel}
            onClick={() => {
              dismissedByUser.current = true;
              setClosing(true);
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
    </div>
  );
}
