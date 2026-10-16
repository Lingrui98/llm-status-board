// R19 详情抽屉的可折叠区块（各维度独立判定 hasData）。
// - hasData=true → 默认展开（图表照常渲染，头部 aria-expanded="true"）；
// - hasData=false → 默认折叠：标题 + 一行说明（复用图表 emptyNote），点击展开；
// - 折叠态内容**不挂载**（因此不进入 Tab 序）；展开态才挂载；
// - 头部是 <button>：Enter/Space 可切、焦点环沿用全局样式；
// - 不记忆（不写 localStorage）：重开抽屉回到「有数据展开 / 无数据折叠」的默认态。

import { useId, useState } from "react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  /** 该维度是否有数据：true → 默认展开；false → 默认折叠并显示一行说明 */
  hasData: boolean;
  /** 折叠态一行说明（复用各图表现有 emptyNote 文案） */
  emptyNote?: string;
  children: ReactNode;
}

export default function DrawerSection({ title, hasData, emptyNote, children }: Props) {
  const [open, setOpen] = useState(hasData);
  const bodyId = `${useId().replace(/:/g, "")}-body`;

  return (
    <section className={`chart-section${hasData ? "" : " chart-section-empty"}`}>
      <button
        type="button"
        className="chart-section-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chart-title">{title}</span>
        {!hasData && <span className="chart-section-note">{emptyNote ?? "暂无数据"}</span>}
        <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className="chart-section-body">
          {children}
        </div>
      )}
    </section>
  );
}
