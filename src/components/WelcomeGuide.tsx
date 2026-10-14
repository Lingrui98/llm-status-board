import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderKind } from "../types";
import { PROVIDER_KINDS } from "../types";
import CredentialHelp from "./CredentialHelp";

interface Props {
  /** 跳过 / 完成引导（App 负责持久化 lsb-guide-dismissed） */
  onDismiss: () => void;
  /** 去设置页添加账号（带预选类型），同时关闭引导 */
  onAddAccount: (kind: ProviderKind) => void;
}

const STEP_TITLES = ["这个应用是干什么的", "添加第一个账号", "凭证怎么填", "完成"];

/**
 * 首次启动引导：账号为空且未跳过过引导时由 App 挂载（居中浮层，不遮挡空状态文案的 DOM 存在性）。
 * 4 步：介绍 → 选类型去添加 → 凭证教程（复用 CredentialHelp）→ 完成提示。
 * ESC / 跳过 / 完成都会关闭；键盘模型与 DetailDrawer 一致（焦点圈闭、还原、锁背景滚动）。
 */
export default function WelcomeGuide({ onDismiss, onAddAccount }: Props) {
  const [step, setStep] = useState(0);
  // 第 ② 步选的类型与第 ③ 步的凭证教程联动
  const [kind, setKind] = useState<ProviderKind>("newApi");
  const panelRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // ESC 关闭（等同跳过）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 焦点管理：打开聚焦面板（tabIndex=-1，不抢首个控件但保证按键落在面板内），卸载还原
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
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

  // Focus trap：Tab 在面板内循环
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

  const last = STEP_TITLES.length - 1;

  return createPortal(
    <div className="guide-backdrop" onMouseDown={onDismiss}>
      <div
        ref={panelRef}
        className="guide-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`新手引导：${STEP_TITLES[step]}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <div className="guide-head">
          <span className="badge badge-relay">新手引导</span>
          <h2>{STEP_TITLES[step]}</h2>
        </div>

        <div className="guide-body">
          {step === 0 && (
            <>
              <p>
                LLM Status Board 把你手头所有 LLM 提供商 / 中转站账号的
                <strong> 余额与用量 </strong>聚合到一块看板上：一张卡片一个账号，余额、今日消费、用量趋势、配额窗口一目了然。
              </p>
              <p>
                数据由各提供商接口直接查询，凭证只保存在本机配置文件，不经过任何第三方服务器。
              </p>
              <p className="muted">整个上手过程大约 3 步、不到 10 分钟：添加账号 → 填凭证 → 测试连接。</p>
            </>
          )}

          {step === 1 && (
            <>
              <p>先选一个最接近你账号的提供商类型 —— 不确定的话，中转站常用「new-api 系中转」：</p>
              <div className="guide-kind-row">
                <select
                  className="help-select"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ProviderKind)}
                  aria-label="预选提供商类型"
                >
                  {[...new Set(PROVIDER_KINDS.map((k) => k.group))].map((group) => (
                    <optgroup key={group} label={group}>
                      {PROVIDER_KINDS.filter((k) => k.group === group).map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button type="button" className="btn primary" onClick={() => onAddAccount(kind)}>
                  去设置添加账号
                </button>
              </div>
              <p className="muted small">点按钮会跳到设置页并预选该类型；也可以点「下一步」先看看凭证怎么填。</p>
            </>
          )}

          {step === 2 && (
            <>
              <p>
                以 <strong>{PROVIDER_KINDS.find((k) => k.value === kind)?.label}</strong> 为例，凭证这样获取：
              </p>
              <CredentialHelp kind={kind} />
              <p className="muted small">填表时表单顶部的「怎么获取凭证？」可以随时再看这份教程。</p>
            </>
          )}

          {step === 3 && (
            <>
              <p>账号保存后建议先点「测试连接」验证凭证；回到看板点顶栏「立即刷新」即可看到余额卡片。</p>
              <p>
                常用快捷键：<kbd>Ctrl</kbd>+<kbd>K</kbd> 命令面板，<kbd>1</kbd>–<kbd>9</kbd> 打开对应账号详情，
                <kbd>ESC</kbd> 关闭面板。
              </p>
              <p className="muted">以后想再看这份引导：顶栏「帮助」→「重新打开新手引导」。</p>
            </>
          )}
        </div>

        <div className="guide-foot">
          {step > 0 ? (
            <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : (
            <button type="button" className="link-btn" onClick={onDismiss}>
              跳过引导
            </button>
          )}
          <div className="guide-dots" aria-hidden="true">
            {STEP_TITLES.map((t, i) => (
              <span key={t} className={`guide-dot${i === step ? " active" : ""}`} />
            ))}
          </div>
          {step < last ? (
            <>
              {step > 0 && (
                <button type="button" className="link-btn" onClick={onDismiss}>
                  跳过引导
                </button>
              )}
              <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
                下一步
              </button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={onDismiss}>
              开始使用
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
