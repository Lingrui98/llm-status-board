import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountConfig } from "../types";

type View = "dashboard" | "settings";

interface Props {
  view: View;
  /** 已启用账号（「跳转到账号」命令的数据源） */
  accounts: AccountConfig[];
  onClose: () => void;
  onRefresh: () => void;
  onNavigate: (view: View) => void;
  onFocusAccount: (accountId: string) => void;
  onOpenHelp: () => void;
  /** 打开通知中心 */
  onOpenNotifications: () => void;
}

type IconKind = "refresh" | "settings" | "board" | "account" | "help" | "bell";

interface Cmd {
  id: string;
  group: string;
  label: string;
  /** 右侧快捷键提示（kbd 样式），仅数字键 1-9 跳转有真实绑定 */
  hint?: string;
  icon: IconKind;
  run: () => void;
}

function CmdIcon({ kind }: { kind: IconKind }) {
  switch (kind) {
    case "refresh":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
          <path d="M13.7 1.8v2.6h-2.6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "settings":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="2.3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path
            d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "board":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      );
    case "account":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M3 13.4c.8-2.4 2.8-3.6 5-3.6s4.2 1.2 5 3.6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "help":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M6.2 6.2c0-1 0.8-1.8 1.8-1.8s1.8 0.8 1.8 1.8c0 1.3-1.8 1.5-1.8 2.8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
        </svg>
      );
    case "bell":
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.8a4.4 4.4 0 0 0-4.4 4.4v2.2c0 .8-.32 1.6-.9 2.2l-.6.6h11.8l-.6-.6a3.1 3.1 0 0 1-.9-2.2V6.2A4.4 4.4 0 0 0 8 1.8Z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinejoin="round"
          />
          <path d="M6.4 13.4a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
  }
}

/**
 * 全局命令面板（Ctrl+K / Ctrl+P 触发，App 层挂载与监听）。
 * 视觉为居中顶部下拉面板；键盘模型采用 aria-activedescendant：
 * 焦点始终留在搜索框，↑↓ 仅移动"活动项"，因此 Tab 天然无需循环陷阱（拦截即可）。
 * 与 DetailDrawer 同样做：ESC 关闭、遮罩点击关闭、焦点还原、背景滚动锁定。
 */
export default function CommandPalette({ view, accounts, onClose, onRefresh, onNavigate, onFocusAccount, onOpenHelp, onOpenNotifications }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 命令列表：操作组（刷新 + 视图切换按当前 view 二选一）+ 每个启用账号一条跳转
  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [
      {
        id: "refresh",
        group: "操作",
        label: "刷新数据",
        icon: "refresh",
        run: () => {
          onClose();
          onRefresh();
        },
      },
      view === "dashboard"
        ? {
            id: "open-settings",
            group: "操作",
            label: "打开设置",
            icon: "settings",
            run: () => {
              onClose();
              onNavigate("settings");
            },
          }
        : {
            id: "back-dashboard",
            group: "操作",
            label: "返回看板",
            icon: "board",
            run: () => {
              onClose();
              onNavigate("dashboard");
            },
          },
      {
        id: "open-notifications",
        group: "操作",
        label: "打开通知",
        icon: "bell",
        run: () => {
          onClose();
          onOpenNotifications();
        },
      },
      {
        id: "open-help",
        group: "操作",
        label: "打开帮助（快捷键 / 凭证教程）",
        icon: "help",
        run: () => {
          onClose();
          onOpenHelp();
        },
      },
    ];
    accounts.forEach((a, i) => {
      // 前 9 个账号与全局数字键 1-9 一一对应（App 层绑定）
      list.push({
        id: `acc-${a.id}`,
        group: "账号",
        label: `跳转到账号：${a.name || "（未命名）"}`,
        hint: i < 9 ? String(i + 1) : undefined,
        icon: "account",
        run: () => {
          onClose();
          onFocusAccount(a.id);
        },
      });
    });
    return list;
  }, [view, accounts, onClose, onRefresh, onNavigate, onFocusAccount, onOpenHelp, onOpenNotifications]);

  // 即时过滤：简单 includes（大小写不敏感）
  const q = query.trim().toLowerCase();
  const filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;

  // 查询变化时回到第一项；过滤结果变短时收敛选中索引
  useEffect(() => setSelected(0), [q]);
  const sel = filtered.length === 0 ? 0 : Math.min(selected, filtered.length - 1);

  // 活动项保持在可视区域内
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [sel, filtered.length]);

  // ESC 关闭（挂 document，面板生命周期内有效；输入框外的焦点也能关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 焦点管理：打开聚焦搜索框，卸载时还给触发前的元素
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => prev?.focus();
  }, []);

  // 锁定背景滚动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) setSelected((sel + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) setSelected((sel - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[sel]?.run();
    } else if (e.key === "Tab") {
      // 焦点恒在搜索框（aria-activedescendant 模式），拦截 Tab 防止逃逸到背景
      e.preventDefault();
    }
  };

  let lastGroup = "";
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
            <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="输入命令或账号名称…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={filtered[sel] ? `palette-item-${filtered[sel].id}` : undefined}
            aria-label="搜索命令"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">无匹配命令</div>
          ) : (
            filtered.map((c, i) => {
              const showGroup = c.group !== lastGroup;
              if (showGroup) lastGroup = c.group;
              return (
                <div key={c.id}>
                  {showGroup && <div className="palette-group">{c.group}</div>}
                  <button
                    type="button"
                    id={`palette-item-${c.id}`}
                    role="option"
                    aria-selected={i === sel}
                    className={`palette-item${i === sel ? " active" : ""}`}
                    onMouseEnter={() => setSelected(i)}
                    onMouseDown={(e) => e.preventDefault() /* 保持焦点在搜索框 */}
                    onClick={() => c.run()}
                  >
                    <span className="palette-icon">
                      <CmdIcon kind={c.icon} />
                    </span>
                    <span className="palette-item-label">{c.label}</span>
                    {c.hint && <kbd>{c.hint}</kbd>}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 执行
          </span>
          <span>
            <kbd>ESC</kbd> 关闭
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
