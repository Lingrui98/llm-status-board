import { useMemo } from "react";
import type { UsagePoint } from "../../types";
import { formatCompact, formatNumber } from "../../format";
import { ChartEmpty } from "./shared";

interface Props {
  data: UsagePoint[] | null | undefined;
  /** 空数据时的具体原因说明 */
  emptyNote?: string;
}

interface Row {
  model: string;
  input: number | null;
  output: number | null;
  total: number;
  /** 是否有输入/输出拆分（无拆分时画单段总量） */
  split: boolean;
}

const MAX_ROWS = 8;

/**
 * Token 输入/输出构成（纯 CSS 横向堆叠条，比 recharts 更轻量）：
 * 合计 modelUsage 的 inputTokens/outputTokens；条长相对最大模型归一，
 * 条内两段按输入/输出比例划分；缺失拆分时退回 tokens 总量单段。
 */
export default function TokenSplitChart({ data, emptyNote }: Props) {
  const { rows, anySplit } = useMemo(() => {
    const byModel = new Map<string, { input: number; output: number; hasIn: boolean; hasOut: boolean; tokens: number; hasTokens: boolean }>();
    for (const p of data ?? []) {
      if (!p || !p.model) continue;
      const name = String(p.model);
      const e = byModel.get(name) ?? { input: 0, output: 0, hasIn: false, hasOut: false, tokens: 0, hasTokens: false };
      if (p.inputTokens !== null && p.inputTokens !== undefined) {
        e.input += p.inputTokens;
        e.hasIn = true;
      }
      if (p.outputTokens !== null && p.outputTokens !== undefined) {
        e.output += p.outputTokens;
        e.hasOut = true;
      }
      if (p.tokens !== null && p.tokens !== undefined) {
        e.tokens += p.tokens;
        e.hasTokens = true;
      }
      byModel.set(name, e);
    }
    const rows: Row[] = [];
    for (const [model, e] of byModel) {
      const split = e.hasIn || e.hasOut;
      const total = e.hasTokens ? e.tokens : split ? e.input + e.output : null;
      if (total === null || total <= 0) continue;
      rows.push({
        model,
        input: e.hasIn ? e.input : null,
        output: e.hasOut ? e.output : null,
        total,
        split,
      });
    }
    rows.sort((a, b) => b.total - a.total);
    return { rows: rows.slice(0, MAX_ROWS), anySplit: rows.some((r) => r.split) };
  }, [data]);

  if (rows.length === 0) {
    return <ChartEmpty text={emptyNote ?? "站点未返回分模型的 Token 明细"} />;
  }

  const maxTotal = Math.max(...rows.map((r) => r.total));

  return (
    <div className="token-split">
      <div className="ts-legend">
        {anySplit ? (
          <>
            <span>
              <i className="donut-dot ts-dot-in" />
              输入 Tokens
            </span>
            <span>
              <i className="donut-dot ts-dot-out" />
              输出 Tokens
            </span>
          </>
        ) : (
          <span>
            <i className="donut-dot ts-dot-total" />
            Tokens 总量（站点未区分输入/输出）
          </span>
        )}
      </div>
      {rows.map((r) => {
        const title = r.split
          ? `${r.model}：输入 ${formatNumber(r.input)} / 输出 ${formatNumber(r.output)} / 合计 ${formatNumber(r.total)} Tokens`
          : `${r.model}：合计 ${formatNumber(r.total)} Tokens`;
        return (
          <div className="ts-row" key={r.model} title={title}>
            <div className="ts-head">
              <span className="ts-model">{r.model}</span>
              <span className="ts-vals">
                {r.split
                  ? `入 ${formatCompact(r.input)} · 出 ${formatCompact(r.output)}`
                  : formatCompact(r.total)}
              </span>
            </div>
            <div className="ts-track">
              {r.split ? (
                <>
                  <div className="ts-seg in" style={{ width: `${((r.input ?? 0) / maxTotal) * 100}%` }} />
                  <div className="ts-seg out" style={{ width: `${((r.output ?? 0) / maxTotal) * 100}%` }} />
                </>
              ) : (
                <div className="ts-seg total" style={{ width: `${(r.total / maxTotal) * 100}%` }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
