import { Children, isValidElement, useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface MasonryItemPosition {
  column: number;
  x: number;
  y: number;
  width: number;
}

export interface MasonryLayout {
  columnCount: number;
  columnWidth: number;
  height: number;
  items: MasonryItemPosition[];
}

/**
 * 按原始顺序把项目分配到各列，每列独立累计高度。
 * 这保留了「第 N + 列数 个项目位于第 N 个项目下方」的行优先语义。
 */
export function computeMasonryLayout(
  containerWidth: number,
  itemHeights: number[],
  minColumnWidth: number,
  gap: number,
): MasonryLayout {
  const columnCount = Math.max(1, Math.floor((containerWidth + gap) / (minColumnWidth + gap)));
  const columnWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
  const columnBottoms = Array.from({ length: columnCount }, () => 0);

  const items = itemHeights.map((rawHeight, index) => {
    const column = index % columnCount;
    const y = columnBottoms[column];
    const height = Math.max(0, rawHeight);
    columnBottoms[column] = y + height + gap;
    return { column, x: column * (columnWidth + gap), y, width: columnWidth };
  });

  return {
    columnCount,
    columnWidth,
    height: itemHeights.length > 0 ? Math.max(0, Math.max(...columnBottoms) - gap) : 0,
    items,
  };
}

interface Props {
  children: ReactNode;
  minColumnWidth?: number;
  gap?: number;
}

/**
 * 保留 DOM 顺序的轻量瀑布网格。
 * ResizeObserver 同时监听容器和卡片，窗口缩放、字体加载与附加信息展开都会触发重排。
 */
export default function MasonryGrid({ children, minColumnWidth = 320, gap = 20 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const childArray = Children.toArray(children);
  const childKeys = childArray.map((child, index) => (isValidElement(child) ? (child.key ?? index) : index));
  const childLayoutKey = JSON.stringify(childKeys);

  // 内容高度变化由 ResizeObserver 捕捉，只有项目身份或顺序变化时才重新绑定。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const elements = Array.from(container.children) as HTMLElement[];
    let frame: number | null = null;
    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const width = container.clientWidth;
      if (width <= 0) return;

      // 先确定列宽，再读取卡片在该列宽下的真实高度。
      const metrics = computeMasonryLayout(width, elements.map(() => 0), minColumnWidth, gap);
      for (const element of elements) element.style.width = `${metrics.columnWidth}px`;
      const heights = elements.map((element) => element.getBoundingClientRect().height);
      const layout = computeMasonryLayout(width, heights, minColumnWidth, gap);

      layout.items.forEach((position, index) => {
        elements[index].style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      });
      container.style.height = `${layout.height}px`;
    };

    const scheduleMeasure = () => {
      if (disposed || frame !== null) return;
      if (typeof window.requestAnimationFrame !== "function") {
        measure();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(container);
    for (const element of elements) observer?.observe(element);
    window.addEventListener("resize", scheduleMeasure);
    measure();

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [childLayoutKey, minColumnWidth, gap]);

  return (
    <div
      ref={containerRef}
      className="card-grid"
      style={{ "--card-grid-gap": `${gap}px` } as CSSProperties}
    >
      {childArray.map((child, index) => (
        <div className="card-grid-item" key={childKeys[index]}>
          {child}
        </div>
      ))}
    </div>
  );
}
