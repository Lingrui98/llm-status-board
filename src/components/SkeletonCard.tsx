/**
 * 加载骨架卡片：形状对齐 ProviderCard 结构（标题行 / 大数字 / 进度条 / 文本行 / 底栏），
 * 仅在「刷新中且无任何旧数据」（首次启动刷新）时占位，避免卡片网格从空白突然跳入。
 * 独立成组件而非内联在 Dashboard：骨架结构是纯展示、与看板数据逻辑无关，
 * 拆出后 Dashboard 只需一个三元表达式，且 shimmer 的 DOM 细节不污染看板代码。
 * shimmer 动画在 prefers-reduced-motion 下退化为静态灰块（见 styles.css）。
 */
export default function SkeletonCard() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <div className="card-head">
        <div className="card-title">
          <span className="skl skl-dot" />
          <span className="skl skl-line" style={{ width: 118 }} />
        </div>
        <span className="skl skl-badge" />
      </div>
      <div className="skl skl-bignum" />
      <div className="skl skl-bar" />
      <div className="card-rows">
        <span className="skl skl-line" style={{ width: "84%" }} />
        <span className="skl skl-line" style={{ width: "66%" }} />
        <span className="skl skl-line" style={{ width: "75%" }} />
      </div>
      <div className="card-foot skeleton-foot">
        <span className="skl skl-line" style={{ width: 96 }} />
        <span className="skl skl-line" style={{ width: 64 }} />
      </div>
    </div>
  );
}
