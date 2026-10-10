import ProviderCard from "./ProviderCard";
import type { AppConfig, Money, RefreshOutcome } from "../types";
import { formatMoney } from "../format";

interface Props {
  config: AppConfig;
  statuses: Record<string, RefreshOutcome>;
  refreshing: boolean;
  lastRefreshAt: string | null;
  autoRefreshSec: number;
}

function aggregate(statuses: Record<string, RefreshOutcome>): { usd: number; cny: number } {
  let usd = 0;
  let cny = 0;
  for (const o of Object.values(statuses)) {
    const b: Money | null | undefined = o.info?.balance;
    if (!b) continue;
    if (b.currency === "USD") usd += b.amount;
    else if (b.currency === "CNY") cny += b.amount;
  }
  return { usd, cny };
}

export default function Dashboard({ config, statuses, refreshing, lastRefreshAt, autoRefreshSec }: Props) {
  const enabled = config.accounts.filter((a) => a.enabled);
  const okCount = Object.values(statuses).filter((s) => s.ok).length;
  const failCount = Object.values(statuses).filter((s) => !s.ok).length;
  const totals = aggregate(statuses);

  if (enabled.length === 0) {
    return (
      <main className="main">
        <div className="empty-state">
          <h2>还没有任何账号</h2>
          <p className="muted">
            点击右上角「设置」添加你想监控的 LLM 提供商 / 中转站账号，然后回到看板查看余额与用量。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <div className="summary-bar">
        <div className="summary-item">
          <span className="summary-label">监控账号</span>
          <span className="summary-value">{enabled.length}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">正常 / 异常</span>
          <span className="summary-value">
            <span className="ok-text">{okCount}</span>
            <span className="muted"> / </span>
            <span className="fail-text">{failCount}</span>
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">余额合计 (USD)</span>
          <span className="summary-value">${totals.usd.toFixed(2)}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">余额合计 (CNY)</span>
          <span className="summary-value">¥{totals.cny.toFixed(2)}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">刷新</span>
          <span className="summary-value small">
            {refreshing ? "进行中…" : lastRefreshAt ? new Date(lastRefreshAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
            {autoRefreshSec > 0 ? ` · 每 ${autoRefreshSec}s` : " · 手动"}
          </span>
        </div>
      </div>

      <div className="card-grid">
        {enabled.map((acc) => (
          <ProviderCard key={acc.id} account={acc} outcome={statuses[acc.id]} refreshing={refreshing} />
        ))}
      </div>
    </main>
  );
}
