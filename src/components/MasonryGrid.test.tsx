import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import MasonryGrid, { computeMasonryLayout } from "./MasonryGrid";

type ObserverCallback = () => void;
const observerCallbacks: ObserverCallback[] = [];
const observedTargets = new Set<HTMLElement>();
let animationCallbacks: Map<number, FrameRequestCallback>;
let nextAnimationId: number;
let originalClientWidth: PropertyDescriptor | undefined;
let originalRect: PropertyDescriptor | undefined;
let heights: number[];
let containerWidth: number;

function flushAnimationFrame() {
  const pending = [...animationCallbacks.values()];
  animationCallbacks.clear();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  observerCallbacks.length = 0;
  observedTargets.clear();
  animationCallbacks = new Map();
  nextAnimationId = 0;
  heights = [180, 260, 210, 150];
  containerWidth = 1000;

  class ResizeObserverStub {
    constructor(callback: ObserverCallback) {
      observerCallbacks.push(callback);
    }
    observe(target: HTMLElement) {
      observedTargets.add(target);
    }
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextAnimationId;
    animationCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationCallbacks.delete(id);
  });

  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("card-grid") ? containerWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const items = this.parentElement ? Array.from(this.parentElement.children) : [];
      const index = this.classList.contains("card-grid-item") ? items.indexOf(this) : -1;
      const height = heights[index] ?? 0;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: height,
        width: 320,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  if (originalRect) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", originalRect);
});

describe("computeMasonryLayout", () => {
  it("第四项紧跟第一项，不受同排最高卡片影响", () => {
    const layout = computeMasonryLayout(1000, [180, 260, 210, 150], 320, 20);
    expect(layout.columnCount).toBe(3);
    expect(layout.items[3]).toMatchObject({ column: 0, x: 0, y: 200, width: 320 });
    expect(layout.height).toBe(350);
  });

  it("窄容器改为单列并保持固定间距", () => {
    const layout = computeMasonryLayout(360, [180, 260, 210], 320, 20);
    expect(layout.columnCount).toBe(1);
    expect(layout.items.map((item) => item.y)).toEqual([0, 200, 480]);
    expect(layout.height).toBe(690);
  });
});

describe("MasonryGrid", () => {
  it("保留 DOM 顺序并应用每列独立的位置", () => {
    const { container } = render(
      <MasonryGrid>
        {["A", "B", "C", "D"].map((name) => (
          <div key={name}>{name}</div>
        ))}
      </MasonryGrid>,
    );
    const grid = container.querySelector(".card-grid") as HTMLElement;
    const items = Array.from(grid.children) as HTMLElement[];

    expect(items.map((item) => item.textContent)).toEqual(["A", "B", "C", "D"]);
    expect(items[3].style.transform).toBe("translate3d(0px, 200px, 0)");
    expect(grid.style.height).toBe("350px");
  });

  it("卡片高度变化后重新计算后续卡片位置", () => {
    const { container, rerender } = render(
      <MasonryGrid>
        {["A", "B", "C", "D"].map((name) => (
          <div key={name}>{name}</div>
        ))}
      </MasonryGrid>,
    );
    const grid = container.querySelector(".card-grid") as HTMLElement;
    const fourth = grid.children[3] as HTMLElement;
    expect(fourth.style.transform).toBe("translate3d(0px, 200px, 0)");

    rerender(
      <MasonryGrid>
        {["A", "B", "C", "D"].map((name) => (
          <div key={name}>{name}</div>
        ))}
      </MasonryGrid>,
    );
    expect(observerCallbacks).toHaveLength(1);

    heights = [220, 260, 210, 150];
    for (const callback of observerCallbacks) callback();
    flushAnimationFrame();

    expect(fourth.style.transform).toBe("translate3d(0px, 240px, 0)");
    expect(grid.style.height).toBe("390px");
  });

  it("容器跨越列数阈值后重新排布", () => {
    const { container } = render(
      <MasonryGrid>
        {["A", "B", "C", "D"].map((name) => (
          <div key={name}>{name}</div>
        ))}
      </MasonryGrid>,
    );
    const grid = container.querySelector(".card-grid") as HTMLElement;

    containerWidth = 660;
    for (const callback of observerCallbacks) callback();
    flushAnimationFrame();

    expect((grid.children[2] as HTMLElement).style.transform).toBe("translate3d(0px, 200px, 0)");
    expect((grid.children[3] as HTMLElement).style.transform).toBe("translate3d(340px, 280px, 0)");
    expect(grid.style.height).toBe("430px");
  });

  it("keyed children 增删后同步测量并观察新节点", () => {
    const threeChildren = ["A", "B", "C"].map((name) => <div key={name}>{name}</div>);
    const { container, rerender } = render(<MasonryGrid>{threeChildren}</MasonryGrid>);
    const grid = container.querySelector(".card-grid") as HTMLElement;
    expect(grid.style.height).toBe("260px");

    rerender(
      <MasonryGrid>
        {["A", "B", "C", "D"].map((name) => (
          <div key={name}>{name}</div>
        ))}
      </MasonryGrid>,
    );
    const fourth = grid.children[3] as HTMLElement;
    expect(observerCallbacks).toHaveLength(2);
    expect(observedTargets.has(fourth)).toBe(true);
    expect(fourth.style.transform).toBe("translate3d(0px, 200px, 0)");
    expect(grid.style.height).toBe("350px");

    rerender(<MasonryGrid>{threeChildren}</MasonryGrid>);
    expect(grid.children).toHaveLength(3);
    expect(grid.style.height).toBe("260px");
  });

  it("卸载时取消尚未执行的布局任务", () => {
    const { unmount } = render(
      <MasonryGrid>
        <div>A</div>
      </MasonryGrid>,
    );
    for (const callback of observerCallbacks) callback();
    expect(animationCallbacks.size).toBe(1);

    unmount();
    expect(animationCallbacks.size).toBe(0);
  });
});
