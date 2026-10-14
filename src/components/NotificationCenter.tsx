import DetailDrawer from "./DetailDrawer";
import { formatTimeAgo } from "../format";
import type { AppNotification, NotificationKind, NotificationReadMap } from "../notifications";
import { KIND_LABELS } from "../notifications";

interface Props {
  /** 当前可见通知（问题类 + 仍有效的恢复类），按时间倒序 */
  notifications: AppNotification[];
  readMap: NotificationReadMap;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}

function NotifIcon({ kind }: { kind: NotificationKind }) {
  switch (kind) {
    case "lowBalance":
      // 钱包/硬币
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.8" y="3.5" width="12.4" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M1.8 6.5h12.4" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="11.4" cy="9.8" r="1" fill="currentColor" />
        </svg>
      );
    case "refreshError":
      // 警示三角
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.2 14.6 13.4H1.4Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
          <path d="M8 6.4v3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="0.85" fill="currentColor" />
        </svg>
      );
    case "quotaFull":
      // 仪表盘/时钟
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "recovered":
      // 对勾圆
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="m5.2 8.2 2 2 3.6-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

/**
 * 通知中心：右侧抽屉（复用 DetailDrawer 的 ESC/遮罩/焦点管理）。
 * 通知本体每次刷新后由 RefreshOutcome[] 重新推导，这里只负责展示与已读管理；
 * 不做系统弹窗/声音，全部提醒停留在应用内（不打扰原则）。
 */
export default function NotificationCenter({ notifications, readMap, onMarkRead, onMarkAllRead, onClose }: Props) {
  const unread = notifications.filter((n) => !readMap[n.id]).length;

  return (
    <DetailDrawer
      title="通知中心"
      subtitle={unread > 0 ? `${unread} 条未读` : undefined}
      onClose={onClose}
    >
      <div className="notif-toolbar">
        <span className="muted small">
          {notifications.length > 0 ? `共 ${notifications.length} 条 · ${unread} 条未读` : "来自最近几次刷新的提醒"}
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={onMarkAllRead}
          disabled={unread === 0}
        >
          全部已读
        </button>
      </div>

      {notifications.length === 0 ? (
        <div className="notif-empty">
          <span className="notif-empty-ico" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path d="m5.2 8.2 2 2 3.6-4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h4>一切正常</h4>
          <p>余额、配额窗口与刷新状态都没有需要关注的问题。出现异常时这里会第一时间列出。</p>
        </div>
      ) : (
        <div className="notif-list">
          {notifications.map((n) => {
            const isUnread = !readMap[n.id];
            return (
              <div key={n.id} className={`notif-item${isUnread ? " unread" : ""}`}>
                <span className={`notif-ico ${n.severity}`}>
                  <NotifIcon kind={n.kind} />
                </span>
                <div className="notif-main">
                  <div className="notif-head">
                    <span className="notif-account">{n.accountName}</span>
                    <span className={`notif-kind ${n.severity}`}>{KIND_LABELS[n.kind]}</span>
                    <span className="notif-time">{formatTimeAgo(n.at)}</span>
                  </div>
                  {n.detail && <p className="notif-detail">{n.detail}</p>}
                </div>
                {isUnread && (
                  <button
                    type="button"
                    className="link-btn notif-read-btn"
                    onClick={() => onMarkRead(n.id)}
                    aria-label={`标为已读：${n.accountName} ${KIND_LABELS[n.kind]}`}
                  >
                    标为已读
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="muted small notif-footnote">
        提醒仅在应用内展示（无系统弹窗/声音）；通知由刷新结果实时推导，已读状态保存在本机。
      </p>
    </DetailDrawer>
  );
}
