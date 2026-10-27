import { useMemo } from "react";
import type { AccountConfig, RefreshOutcome } from "../types";
import type { BalanceTotals } from "../balances";
import { accountCostsForDate, dashboardCurrency } from "../dashboardData";
import { formatDurationMs } from "../format";
import { toLocalDateKey } from "../usageHistory";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
  totals: BalanceTotals;
  refreshing: boolean;
  lastRefreshAt: string | null;
  lastRefreshMs?: number | null;
  autoRefreshSec: number;
  todayKey?: string;
  onOpenNotifications?: () => void;
  onRefresh?: () => void;
}

function KpiIcon({ kind }: { kind: "accounts" | "dollar" | "yuan" | "refresh" }) {
  const paths = {
    accounts: <><rect x="4" y="4" width="16" height="6" rx="2" /><rect x="4" y="14" width="16" height="6" rx="2" /><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" /></>,
    dollar: <path d="M12 3v18M17 7.5c-.8-1.5-2.5-2.2-4.7-2.2-2.8 0-4.8 1.4-4.8 3.6 0 5.3 9.7 2.5 9.7 7.3 0 2.4-2 3.8-5 3.8-2.5 0-4.5-.9-5.3-2.7" />,
    yuan: <path d="m6 4 6 8 6-8M12 12v8M7 13h10M7 17h10" />,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 6" /><path d="M20 5v6h-6" /></>,
  };
  return (
    <span className={`kpi-icon kpi-icon-${kind}`} aria-hidden="true">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {paths[kind]}
      </svg>
    </span>
  );
}

function moneyText(amount: number, currency: "USD" | "CNY"): string {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${Math.abs(amount).toFixed(2)}`;
}

export default function OverviewCards({
  accounts,
  statuses,
  totals,
  refreshing,
  lastRefreshAt,
  lastRefreshMs,
  autoRefreshSec,
  todayKey,
  onOpenNotifications,
  onRefresh,
}: Props) {
  const outcomes = useMemo(() => accounts.map((account) => statuses[account.id]).filter((o): o is RefreshOutcome => !!o), [accounts, statuses]);
  const okCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.length - okCount;
  const today = todayKey ?? toLocalDateKey();
  const dailyCosts = useMemo(() => {
    const result: Record<string, { amount: number; accounts: number }> = {};
    for (const outcome of outcomes) {
      const costs = accountCostsForDate(outcome.info, today);
      for (const [rawCurrency, amount] of Object.entries(costs)) {
        const currency = dashboardCurrency(rawCurrency);
        const entry = result[currency] ?? { amount: 0, accounts: 0 };
        entry.amount += amount;
        entry.accounts += 1;
        result[currency] = entry;
      }
    }
    return result;
  }, [outcomes, today]);

  const balanceAccounts = (currency: "USD" | "CNY") =>
    outcomes.filter((o) => dashboardCurrency(o.info?.balance?.currency) === currency).length;
  const costHint = (currency: "USD" | "CNY") => {
    const cost = dailyCosts[currency];
    if (!cost) return "今日暂无费用数据";
    const sign = cost.amount > 0 ? "−" : cost.amount < 0 ? "+" : "";
    return `今日 ${sign}${moneyText(cost.amount, currency)}`;
  };
  const refreshTime = refreshing
    ? "进行中…"
    : lastRefreshAt
      ? new Date(lastRefreshAt).toLocaleTimeString("zh-CN", { hour12: false })
      : "—";
  const refreshHint = [
    autoRefreshSec > 0 ? `每 ${autoRefreshSec}s 自动` : "手动刷新",
    !refreshing && lastRefreshMs != null ? `耗时 ${formatDurationMs(lastRefreshMs)}` : "",
    onRefresh ? "点击刷新" : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className="overview-grid" aria-label="账号总览">
      <article className="kpi-card">
        <span className="kpi-label">监控账号<KpiIcon kind="accounts" /></span>
        <span className="kpi-value">{accounts.length}</span>
        <span className="kpi-hint">
          <span className="ok-text">{okCount} 正常</span>
          <span className="kpi-separator">·</span>
          {failCount > 0 && onOpenNotifications ? (
            <button type="button" className="kpi-alert-link" onClick={onOpenNotifications} title="查看异常账号">
              {failCount} 异常
            </button>
          ) : (
            <span className={failCount > 0 ? "fail-text" : "muted"}>{failCount} 异常</span>
          )}
        </span>
      </article>

      <article className="kpi-card">
        <span className="kpi-label">余额合计 · USD<KpiIcon kind="dollar" /></span>
        <span className="kpi-value kpi-money">${totals.usd.toFixed(2)}</span>
        <span className="kpi-hint muted">{balanceAccounts("USD")} 个账号 · {costHint("USD")}</span>
      </article>

      <article className="kpi-card">
        <span className="kpi-label">余额合计 · CNY<KpiIcon kind="yuan" /></span>
        <span className="kpi-value kpi-money">¥{totals.cny.toFixed(2)}</span>
        <span className="kpi-hint muted">{balanceAccounts("CNY")} 个账号 · {costHint("CNY")}</span>
      </article>

      {onRefresh ? (
        <button type="button" className="kpi-card kpi-refresh" onClick={onRefresh} disabled={refreshing} title="立即刷新全部账号">
          <span className="kpi-label">上次刷新<KpiIcon kind="refresh" /></span>
          <span className="kpi-value kpi-time">{refreshTime}</span>
          <span className="kpi-hint muted">{refreshHint}</span>
        </button>
      ) : (
        <article className="kpi-card">
          <span className="kpi-label">上次刷新<KpiIcon kind="refresh" /></span>
          <span className="kpi-value kpi-time">{refreshTime}</span>
          <span className="kpi-hint muted">{refreshHint}</span>
        </article>
      )}
    </section>
  );
}
