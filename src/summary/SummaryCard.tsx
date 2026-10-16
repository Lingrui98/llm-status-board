// R18 托盘悬停「用量总结」浮层 —— 纯展示卡。
// 与数据获取解耦：三态（loading / error / empty / ready）由外部注入，便于注水单测。
// 版式：头部（标题 + 最后刷新）→ 总览 2×2 数字（复用 StatTile，去第二层边框）→
// 账号行（状态点 + 名称/异常摘要 + 数值，区段内滚动）→ 本地历史天数。

import StatTile from "../components/ui/StatTile";
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
}

const STATUS_LABEL: Record<SummaryRowStatus, string> = {
  ok: "正常",
  err: "异常",
  idle: "未刷新",
};

export default function SummaryCard({ status, data, onSelectAccount, onPointerEnter, onPointerLeave }: Props) {
  const refreshText = status === "ready" ? (data?.lastRefreshText ?? "—") : status === "loading" ? "读取中…" : "—";
  const historyText =
    status === "ready" ? (data && data.historyDays > 0 ? `本地历史 ${data.historyDays} 天` : "本地历史随刷新自动积累") : "";

  return (
    <div className="summary-shell" onMouseEnter={onPointerEnter} onMouseLeave={onPointerLeave}>
      <section className="summary-card" aria-label="用量总结">
        <header className="summary-head">
          <h1 className="summary-title">用量总结</h1>
          <span className="summary-refresh">{refreshText}</span>
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

            <ul className="summary-rows" aria-label="账号余额">
              {data.rows.map((row) => (
                <li key={row.accountId}>
                  <button
                    type="button"
                    className="summary-row"
                    onClick={() => onSelectAccount?.(row.accountId)}
                    title={`查看 ${row.name} 详情`}
                  >
                    <span className={`summary-dot ${row.status}`} aria-hidden="true" />
                    <span className="sr-only">{STATUS_LABEL[row.status]}</span>
                    <span className="summary-row-main">
                      <span className="summary-row-name" title={row.name}>
                        {row.name}
                      </span>
                      {row.detailText && (
                        <span className="summary-row-detail" title={row.detailText}>
                          {row.detailText}
                        </span>
                      )}
                    </span>
                    <span className="summary-row-value">{row.valueText}</span>
                  </button>
                </li>
              ))}
            </ul>

            <footer className="summary-foot">{historyText}</footer>
          </>
        )}
      </section>
    </div>
  );
}
