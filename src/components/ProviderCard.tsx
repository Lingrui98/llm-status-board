import { useState } from "react";
import type { AccountConfig, RefreshOutcome } from "../types";
import { formatMoney, formatNumber, formatTime, kindLabel } from "../format";

interface Props {
  account: AccountConfig;
  outcome?: RefreshOutcome;
  refreshing: boolean;
}

function statusClass(outcome?: RefreshOutcome, refreshing?: boolean): string {
  if (!outcome) return refreshing ? "pending" : "unknown";
  return outcome.ok ? "ok" : "error";
}

export default function ProviderCard({ account, outcome, refreshing }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const info = outcome?.info ?? null;
  const err = outcome?.error ?? null;

  // 用量进度条
  const used = info?.used?.amount;
  const total = info?.total?.amount;
  let pct: number | null = null;
  if (used !== undefined && used !== null && total !== undefined && total !== null && total > 0) {
    pct = Math.min(100, Math.max(0, (used / total) * 100));
  } else if (info?.balance && total) {
    const bal = info.balance.amount;
    if (total > 0) pct = Math.min(100, Math.max(0, ((total - bal) / total) * 100));
  }

  const balance = info?.balance ?? null;
  const lowBalance = balance !== null && balance.amount >= 0 && balance.amount < 1 && (balance.currency === "USD" || balance.currency === "CNY");

  return (
    <div className={`card status-${statusClass(outcome, refreshing)}`}>
      <div className="card-head">
        <div className="card-title">
          <span className={`dot ${statusClass(outcome, refreshing)}`} />
          <span className="card-name">{account.name}</span>
        </div>
        <span className="kind-badge">{kindLabel(account.kind)}</span>
      </div>

      <div className="card-balance">
        <span className="balance-label">余额</span>
        <span className={`balance-value${lowBalance ? " low" : ""}`}>{formatMoney(balance)}</span>
      </div>

      {pct !== null && (
        <div className="usage-bar">
          <div className="usage-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
      )}

      <div className="card-rows">
        <div className="card-row">
          <span className="row-label">已用</span>
          <span className="row-value">{formatMoney(info?.used)}</span>
        </div>
        <div className="card-row">
          <span className="row-label">总额度</span>
          <span className="row-value">{formatMoney(info?.total)}</span>
        </div>
        {info?.requests !== null && info?.requests !== undefined && (
          <div className="card-row">
            <span className="row-label">请求数</span>
            <span className="row-value">{formatNumber(info.requests)}</span>
          </div>
        )}
        {(info?.extras ?? []).map((kv) => (
          <div className="card-row" key={kv.key}>
            <span className="row-label">{kv.key}</span>
            <span className="row-value">{kv.value}</span>
          </div>
        ))}
      </div>

      {info?.note && <p className="note">{info.note}</p>}

      {err && <p className="error-text">{err}</p>}

      <div className="card-foot">
        <span className="muted small">
          {info ? `更新于 ${formatTime(info.fetchedAt)}` : refreshing && !outcome ? "等待数据…" : "尚未刷新"}
        </span>
        {info?.raw !== undefined && info?.raw !== null && (
          <button className="link-btn" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? "隐藏原始数据" : "原始数据"}
          </button>
        )}
      </div>

      {showRaw && info?.raw != null && (
        <pre className="raw-json">{JSON.stringify(info.raw, null, 2) as string}</pre>
      )}
    </div>
  );
}
