import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** 抽屉标题（账号名），同时用作 aria-label */
  title: string;
  /** 标题旁的副说明（如账号类型徽章文案） */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 详情抽屉：右侧滑入的浮层（portal 到 body，脱离卡片网格文档流），
 * 展开/收起不影响任何卡片布局。ESC 或点击遮罩关闭；
 * 打开时焦点移入关闭按钮，关闭后焦点还原到触发按钮。
 */
export default function DetailDrawer({ title, subtitle, onClose, children }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ESC 关闭（监听挂 document，抽屉生命周期内有效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 焦点管理：打开聚焦关闭按钮，卸载时还给触发元素（键盘可达性）
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => prev?.focus();
  }, []);

  // 锁定背景滚动（抽屉自身内容可滚动）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus trap：Tab 到最后一个可聚焦元素后回到第一个，Shift+Tab 反向循环
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 详情`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <div className="drawer-head">
          <div className="drawer-title-group">
            <h3 className="drawer-title">{title}</h3>
            {subtitle && <span className="kind-badge">{subtitle}</span>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭（ESC）"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
