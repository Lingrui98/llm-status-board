import type { QuotaWindow } from "../../types";
import { formatTimeUntil } from "../../format";
import { ChartEmpty } from "./shared";

interface Props {
  windows: QuotaWindow[] | null | undefined;
}

function levelOf(pct: number): "ok" | "warn" | "err" {
  if (pct > 80) return "err";
  if (pct >= 60) return "warn";
  return "ok";
}

function resetText(iso: string): string {
  const until = formatTimeUntil(iso);
  return until === "已到期" ? until : `${until}重置`;
}

/** 配额窗口进度条组（纯 CSS）：<60% 绿、60-80% 琥珀、>80% 红，附重置倒计时 */
export default function QuotaWindowBars({ windows }: Props) {
  const list = (windows ?? []).filter(
    (w): w is QuotaWindow & { usedPercent: number } =>
      !!w && typeof w.usedPercent === "number" && !Number.isNaN(w.usedPercent),
  );
  if (list.length === 0) return <ChartEmpty height={56} />;

  return (
    <div className="quota-bars">
      {list.map((w, i) => {
        const pct = Math.min(100, Math.max(0, w.usedPercent));
        const level = levelOf(pct);
        return (
          <div className="quota-row" key={`${w.window ?? "window"}-${i}`}>
            <div className="quota-info">
              <span className="quota-label">{w.window ?? "配额"}</span>
              {w.resetsAt && <span className="quota-reset">{resetText(w.resetsAt)}</span>}
              <span className={`quota-pct ${level}`}>{pct.toFixed(0)}%</span>
            </div>
            <div className="quota-track">
              <div className={`quota-fill ${level}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
