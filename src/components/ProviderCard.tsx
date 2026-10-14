import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountConfig, BalanceSnapshot, KeyValue, RefreshOutcome } from "../types";
import { formatMoney, formatMoneyParts, formatNumber, formatTime, formatTimeAgo, kindLabel } from "../format";
import DailyUsageChart from "./charts/DailyUsageChart";
import ModelUsageChart from "./charts/ModelUsageChart";
import QuotaWindowBars from "./charts/QuotaWindowBars";
import BalanceTrendChart from "./charts/BalanceTrendChart";
import BalanceBreakdownChart from "./charts/BalanceBreakdownChart";
import TokenSplitChart from "./charts/TokenSplitChart";
import { ChartSection } from "./charts/shared";
import DetailDrawer from "./DetailDrawer";

interface Props {
  account: AccountConfig;
  outcome?: RefreshOutcome;
  refreshing: boolean;
  snapshots: BalanceSnapshot[];
  /** 看板级"当前时间"（每 30s 跳动），用于相对时间显示；缺省按渲染时刻算 */
  now?: number;
}

function statusClass(outcome?: RefreshOutcome, refreshing?: boolean): string {
  if (!outcome) return refreshing ? "pending" : "unknown";
  return outcome.ok ? "ok" : "error";
}

function usageLevel(pct: number): "ok" | "warn" | "err" {
  if (pct > 80) return "err";
  if (pct >= 60) return "warn";
  return "ok";
}

/** 配额/窗口类的附加信息优先靠前（用户最关心剩余额度），其余保持原始顺序（稳定分组） */
const QUOTA_KEY_RE = /窗口|用量|上限/;

function sortExtras(extras: KeyValue[]): KeyValue[] {
  const pri: KeyValue[] = [];
  const rest: KeyValue[] = [];
  for (const kv of extras) (QUOTA_KEY_RE.test(kv.key) ? pri : rest).push(kv);
  return [...pri, ...rest];
}

/** 复制到剪贴板：优先 navigator.clipboard，不可用时退回 execCommand（旧 WebView/权限受限） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 附加信息行数超过该值时折叠（默认露出前 EXTRAS_PREVIEW 行） */
const EXTRAS_COLLAPSE_AT = 6;
const EXTRAS_PREVIEW = 5;

export default function ProviderCard({ account, outcome, refreshing, snapshots, now }: Props) {
  // 详情抽屉：图表与原始数据都放入右侧浮层，卡片高度不再随展开变化（grid 行稳定）
  const [detailOpen, setDetailOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [showAllExtras, setShowAllExtras] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const info = outcome?.info ?? null;
  const err = outcome?.error ?? null;
  const st = statusClass(outcome, refreshing);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

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
  const balanceParts = formatMoneyParts(balance);
  const lowBalance = balance !== null && balance.amount >= 0 && balance.amount < 1 && (balance.currency === "USD" || balance.currency === "CNY");

  // 附加信息：配额类靠前；行数多时默认折叠（与图表「详情」展开互不影响）
  const sortedExtras = useMemo(() => sortExtras(info?.extras ?? []), [info?.extras]);
  const extrasCollapsible = sortedExtras.length > EXTRAS_COLLAPSE_AT;
  const visibleExtras =
    extrasCollapsible && !showAllExtras ? sortedExtras.slice(0, EXTRAS_PREVIEW) : sortedExtras;

  const ago = info ? formatTimeAgo(info.fetchedAt, now ?? Date.now()) : null;

  const handleCopyError = async () => {
    if (!err) return;
    if (!(await copyText(err))) return;
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`card status-${st}`}>
      <div className="card-head">
        <div className="card-title">
          <span className={`dot ${st}`} />
          <span className="card-name">{account.name}</span>
        </div>
        <div className="card-head-meta">
          {ago !== null && (
            <span className="card-ago" title={`更新于 ${formatTime(info?.fetchedAt)}`}>
              {ago}
            </span>
          )}
          <span className="kind-badge">{kindLabel(account.kind)}</span>
        </div>
      </div>

      <div className="card-balance">
        <span className="balance-label">余额</span>
        <span className={`balance-value${lowBalance ? " low" : ""}`}>
          {balanceParts ? (
            <>
              {/* 完整字符串给读屏与测试定位用；视觉层拆成「大数字 + 小号上标货币」 */}
              <span className="sr-only">{formatMoney(balance)}</span>
              <span className="balance-num" aria-hidden="true">
                {balanceParts.num}
              </span>
              <span className="balance-currency" aria-hidden="true">
                {balanceParts.currency}
              </span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>

      {pct !== null && (
        <div className="usage-block">
          <div className="usage-head">
            <span>额度使用</span>
            <span className={`usage-pct ${usageLevel(pct)}`}>{pct.toFixed(0)}%</span>
          </div>
          <div className="usage-bar">
            <div className={`usage-bar-fill ${usageLevel(pct)}`} style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
        </div>
      )}

      {info?.quotaWindows && info.quotaWindows.length > 0 && (
        <QuotaWindowBars windows={info.quotaWindows} />
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
        {visibleExtras.map((kv) => (
          <div className="card-row" key={kv.key}>
            <span className="row-label">{kv.key}</span>
            <span className="row-value">{kv.value}</span>
          </div>
        ))}
        {extrasCollapsible && (
          <button
            type="button"
            className="link-btn extras-toggle"
            aria-expanded={showAllExtras}
            onClick={() => setShowAllExtras((v) => !v)}
          >
            {showAllExtras ? "收起附加信息" : `展开全部 ${sortedExtras.length} 行`}
            <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {info?.note && (
        <p className="note">
          <svg className="note-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M8 7.3v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
          </svg>
          <span>{info.note}</span>
        </p>
      )}

      {err && (
        <button
          type="button"
          className={`error-text error-copy${copied ? " copied" : ""}`}
          onClick={handleCopyError}
          title="点击复制错误信息"
        >
          <span className="error-msg">{err}</span>
          <span className="copy-hint" aria-hidden="true">
            {copied ? "已复制" : "点击复制"}
          </span>
        </button>
      )}

      <div className="card-foot">
        <span className="muted small">
          {info ? `更新于 ${formatTime(info.fetchedAt)}` : refreshing && !outcome ? "等待数据…" : "尚未刷新"}
        </span>
        <div className="card-actions">
          {info?.raw !== undefined && info?.raw !== null && (
            <button
              className="link-btn"
              onClick={() => {
                setRawOpen(true);
                setDetailOpen(true);
              }}
            >
              原始数据
            </button>
          )}
          <button
            className="link-btn expand-toggle"
            aria-expanded={detailOpen}
            onClick={() => {
              if (detailOpen) {
                setDetailOpen(false);
              } else {
                setRawOpen(false);
                setDetailOpen(true);
              }
            }}
          >
            {detailOpen ? "收起" : "详情"}
            <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {detailOpen && (
        <DetailDrawer
          title={account.name}
          subtitle={kindLabel(account.kind)}
          onClose={() => setDetailOpen(false)}
        >
          <div className="drawer-charts">
            <ChartSection title="额度构成">
              <BalanceBreakdownChart info={info} emptyNote={chartEmptyNote("breakdown")} />
            </ChartSection>
            <ChartSection title="近 14 天用量">
              <DailyUsageChart data={info?.dailyUsage} emptyNote={chartEmptyNote("daily")} />
            </ChartSection>
            <ChartSection title="模型用量 TOP 8">
              <ModelUsageChart data={info?.modelUsage} emptyNote={chartEmptyNote("model")} />
            </ChartSection>
            <ChartSection title="Token 输入 / 输出构成">
              <TokenSplitChart data={info?.modelUsage} emptyNote={chartEmptyNote("token")} />
            </ChartSection>
            <ChartSection title="余额趋势">
              <BalanceTrendChart
                snapshots={snapshots}
                accountId={account.id}
                emptyNote={chartEmptyNote("balance")}
              />
            </ChartSection>
          </div>
          {info?.raw !== undefined && info?.raw !== null && (
            <div className="drawer-raw">
              <button
                type="button"
                className="link-btn extras-toggle"
                aria-expanded={rawOpen}
                onClick={() => setRawOpen((v) => !v)}
              >
                {rawOpen ? "隐藏原始数据" : "原始数据"}
                <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {rawOpen && (
                <pre className="raw-json">{JSON.stringify(info.raw, null, 2) as string}</pre>
              )}
            </div>
          )}
        </DetailDrawer>
      )}
    </div>
  );

  /** 按账号类型与图表维度生成「无数据」说明（区分"不支持"与"暂无记录"） */
  function chartEmptyNote(dimension: "daily" | "model" | "balance" | "breakdown" | "token"): string | undefined {
    const kind = account.kind;
    // 官方按量计费接口只提供余额快照，无历史用量
    if (kind === "deepSeek" && dimension !== "balance" && dimension !== "breakdown") {
      return "DeepSeek 官方接口不提供历史用量，只返回当前余额";
    }
    if (kind === "moonshot" && dimension !== "balance" && dimension !== "breakdown") {
      return "Kimi 订阅接口只返回当前窗口用量百分比，无历史序列";
    }
    if (kind === "moonshot" && dimension === "balance") {
      return "订阅模式按窗口额度计费，没有余额概念（加油包/会员等级见卡片统计行）";
    }
    if (kind === "openAi" && dimension !== "balance" && dimension !== "breakdown") {
      return "此图表依赖站点返回的按日/按模型统计；OpenAI 成本接口仅有按月聚合";
    }
    if (dimension === "breakdown") {
      return "该账号既无总额度/余额构成，也无配额窗口数据，无法绘制额度构成";
    }
    if (dimension === "token") {
      return "该站点尚未返回分模型 Token 明细（新 key 或零消费时为空）";
    }
    if (dimension === "balance" && info?.balance == null && info?.quotaWindows?.length) {
      return "该账号为订阅/配额模式，无余额记录（窗口用量见卡片进度条）";
    }
    if (dimension === "daily" || dimension === "model") {
      return "该站点尚未返回用量统计（新 key 或零消费时为空）";
    }
    return "刷新几次后会随历史快照积累出趋势线";
  }
}
