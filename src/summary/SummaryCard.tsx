// R18 托盘悬停「用量总结」浮层 —— 纯展示卡。
// 与数据获取解耦：三态（loading / error / empty / ready）由外部注入，便于注水单测。
// 版式：头部（标题 + 最后刷新）→ 总览 2×2 数字（复用 StatTile 的紧凑样式）→
// 账号行（状态点 + 名称/异常摘要 + 数值 + R23 配额窗口明细条，区段内滚动）→ 本地历史天数。

import StatTile from "../components/ui/StatTile";
import { formatTimeUntil } from "../format";
import {
  clampPercent,
  quotaLevel,
  trimNumberText,
  windowLabel,
  windowUsageText,
  type QuotaDetailDisplay,
} from "../primaryMetric";
import type { QuotaWindow } from "../types";
import type { SummaryData } from "./summaryData";
import type { SummaryRowStatus } from "./summaryData";

export type SummaryStatus = "loading" | "error" | "empty" | "ready";

interface Props {
  status: SummaryStatus;
  /** ready 时的视图模型；其余状态可为空 */
  data?: SummaryData | null;
  /** 点击账号行 → 打开主窗口并聚焦该账号 */
  onSelectAccount?: (accountId: string) => void;
  /** 指针进入/离开浮层（用于取消/重建后端的待隐藏定时器） */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  /** R24：按下右下角拖拽手柄 → 开始原生尺寸拖拽（无边框窗口的常规做法） */
  onStartResize?: () => void;
}

const STATUS_LABEL: Record<SummaryRowStatus, string> = {
  ok: "正常",
  err: "异常",
  idle: "未刷新",
};

/** R23：单个配额窗口的明细行 —— percent：直条（fill=已用，主卡同色系）+ 已用% + 重置倒计时；raw：纯数字文本 */
function WindowDetail({ w, mode }: { w: QuotaWindow & { usedPercent: number }; mode: QuotaDetailDisplay }) {
  const label = windowLabel(w);
  // 重置倒计时：缺失/已过期不显示（数据层未知时不编造）
  const reset = w.resetsAt ? formatTimeUntil(w.resetsAt) : null;
  const resetText = reset && reset !== "已到期" && reset !== "—" ? `${reset}重置` : null;

  if (mode === "raw" && w.usedAmount && w.limitAmount) {
    return (
      <span className="summary-window">
        <span className="summary-window-label">{label}</span>
        <span className="summary-window-text">{windowUsageText(w, mode)}</span>
        {resetText && <span className="summary-window-reset">{resetText}</span>}
      </span>
    );
  }

  const pct = clampPercent(w.usedPercent);
  const level = quotaLevel(pct);
  return (
    <span className="summary-window">
      <span className="summary-window-label">{label}</span>
      <span className="summary-window-track" aria-hidden="true">
        <span className={`summary-window-fill ${level}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`summary-window-text ${level}`}>已用 {trimNumberText(w.usedPercent)}%</span>
      {resetText && <span className="summary-window-reset">{resetText}</span>}
    </span>
  );
}

export default function SummaryCard({ status, data, onSelectAccount, onPointerEnter, onPointerLeave, onStartResize }: Props) {
  const refreshText = status === "ready" ? (data?.lastRefreshText ?? "—") : status === "loading" ? "读取中…" : "—";
  const historyText =
    status === "ready" ? (data && data.historyDays > 0 ? `本地历史 ${data.historyDays} 天` : "本地历史随刷新自动积累") : "";

  return (
    <div className="summary-shell" onMouseEnter={onPointerEnter} onMouseLeave={onPointerLeave}>
      <section className="summary-card" aria-label="用量总结">
        <header className="summary-head">
          <div className="summary-heading">
            <span className="summary-brand-mark" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
                <path d="M4 12.5V9M9 12.5V4.5M14 12.5V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <h1 className="summary-title">用量总结</h1>
          </div>
          <span className="summary-refresh">
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path d="M8 4.8v3.6l2.3 1.4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {refreshText}
          </span>
        </header>

        {status === "loading" && (
          <div className="summary-loading" role="status" aria-label="读取中">
            <div className="summary-skeleton-row" />
            <div className="summary-skeleton-row" />
          </div>
        )}

        {status === "error" && <p className="summary-state">读取失败，可在主窗口重试</p>}

        {status === "empty" && <p className="summary-state">尚未添加账号</p>}

        {status === "ready" && data && (
          <>
            <div className="summary-overview">
              <StatTile label="监控账号" value={data.total} />
              <StatTile
                label="正常 / 异常"
                value={`${data.okCount} / ${data.failCount}`}
                tone={data.failCount === 0 ? "ok" : "err"}
                hint={data.idleCount > 0 ? `${data.idleCount} 个未刷新` : undefined}
              />
              <StatTile label="余额合计 · USD" value={data.usdText} />
              <StatTile label="余额合计 · CNY" value={data.cnyText} />
            </div>

            <div className="summary-section-head">
              <span>账号明细</span>
              <span>点击查看详情</span>
            </div>

            <ul className="summary-rows" aria-label="账号余额">
              {data.rows.map((row) => (
                <li key={row.accountId}>
                  <button
                    type="button"
                    className={`summary-row${row.windows.length > 0 ? " with-windows" : ""}`}
                    onClick={() => onSelectAccount?.(row.accountId)}
                    title={`查看 ${row.name} 详情`}
                  >
                    <span className="summary-row-line">
                      <span className={`summary-dot ${row.status}`} aria-hidden="true" />
                      <span className="sr-only">{STATUS_LABEL[row.status]}</span>
                      <span className="summary-row-main">
                        <span className="summary-row-name" title={row.name}>
                          {row.name}
                        </span>
                      </span>
                      <span className="summary-row-value">{row.valueText}</span>
                      <svg className="summary-row-arrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path d="m4 2.5 3.5 3.5L4 9.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {/* R23：配额窗口明细（每个有效窗口一行）；高度随窗口数增长，行区已有滚动 */}
                    {row.windows.length > 0 && (
                      <span className="summary-windows">
                        {row.windows.map((w, i) => (
                          <WindowDetail key={`${windowLabel(w)}-${i}`} w={w} mode={data.quotaDisplay} />
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            <footer className="summary-foot">{historyText}</footer>
          </>
        )}
      </section>
      {/* R24：右下角尺寸拖拽手柄（按下即进入原生尺寸拖拽；尺寸由 SummaryPopup 持久化） */}
      <span
        className="summary-resize-grip"
        role="presentation"
        title="拖拽调整浮层大小"
        onMouseDown={(e) => {
          e.preventDefault();
          onStartResize?.();
        }}
      />
    </div>
  );
}
