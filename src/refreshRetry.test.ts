// R16 §5 自动重试单测：退避参数、上限、不并发、取消语义。
// 用注入的假定时器 + 假时钟，断言不依赖真实时间，也不随运行机器变化。

import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshRetryController, isWholeRoundFailure, retryDelayMs } from "./refreshRetry";

describe("retryDelayMs：指数退避 1000×2^(k−1)", () => {
  it("k=1,2,3 → 1000 / 2000 / 4000，累计 7000", () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(1) + retryDelayMs(2) + retryDelayMs(3)).toBe(7000);
  });

  it("k ≤ 0 按第 1 次处理；非整数向下取整", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(-5)).toBe(1000);
    expect(retryDelayMs(2.9)).toBe(2000);
  });
});

describe("RefreshRetryController：调度与上限", () => {
  function forTests() {
    const timerRef: { fn: (() => void) | null; ms: number | null } = { fn: null, ms: null };
    let clock = 1_000_000;
    const control = {
      set: (fn: () => void, ms: number) => {
        timerRef.fn = fn;
        timerRef.ms = ms;
        return 1;
      },
      clear: () => {
        timerRef.fn = null;
        timerRef.ms = null;
      },
    };
    const ctrl = new RefreshRetryController({
      now: () => clock,
      setTimeout: control.set,
      clearTimeout: control.clear,
    });
    return {
      ctrl,
      timerRef,
      advance(ms: number) {
        clock += ms;
      },
      fire() {
        const fn = timerRef.fn;
        timerRef.fn = null;
        fn?.();
      },
    };
  }

  it("AC-14：max=3 → 依次等待 1000 / 2000 / 4000 后各触发一次（累计 7000）", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 3;
    const fired: number[] = [];
    t.ctrl.onFire = (n) => fired.push(n);

    expect(t.ctrl.schedule()).toBe(true);
    expect(t.timerRef.ms).toBe(1000); // 第 1 次
    t.advance(1000);
    t.fire();
    expect(fired).toEqual([1]);

    expect(t.ctrl.schedule()).toBe(true);
    expect(t.timerRef.ms).toBe(2000); // 第 2 次
    t.advance(2000);
    t.fire();
    expect(fired).toEqual([1, 2]);

    expect(t.ctrl.schedule()).toBe(true);
    expect(t.timerRef.ms).toBe(4000); // 第 3 次
    t.advance(4000);
    t.fire();
    expect(fired).toEqual([1, 2, 3]);
  });

  it("AC-14：max=1 只重试 1 次；用尽后再 schedule 返回 false（如实报失败）", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 1;
    const fired: number[] = [];
    t.ctrl.onFire = (n) => fired.push(n);

    expect(t.ctrl.schedule()).toBe(true);
    expect(t.timerRef.ms).toBe(1000);
    t.fire();
    expect(fired).toEqual([1]);
    // 已达上限 → 不再安排
    expect(t.ctrl.schedule()).toBe(false);
    expect(t.timerRef.fn).toBeNull();
  });

  it("AC-14：开关关闭 或 max=0 → 从不重试", () => {
    const t1 = forTests();
    t1.ctrl.enabled = false;
    t1.ctrl.maxRetries = 3;
    expect(t1.ctrl.schedule()).toBe(false);
    expect(t1.timerRef.fn).toBeNull();

    const t2 = forTests();
    t2.ctrl.enabled = true;
    t2.ctrl.maxRetries = 0;
    expect(t2.ctrl.schedule()).toBe(false);
    expect(t2.timerRef.fn).toBeNull();
  });

  it("AC-16：任一时刻最多一个待执行重试（重复 schedule 不叠加）", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 3;
    expect(t.ctrl.schedule()).toBe(true);
    expect(t.ctrl.schedule()).toBe(false); // 已有待执行 → 不再安排
    expect(t.ctrl.pending).toBe(true);
    expect(t.ctrl.attemptCount).toBe(1);
  });

  it("AC-16：cancel() 清定时器并把退避计数归零", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 3;
    const fired: number[] = [];
    t.ctrl.onFire = (n) => fired.push(n);
    t.ctrl.schedule();
    t.ctrl.cancel();
    expect(t.ctrl.pending).toBe(false);
    expect(t.ctrl.attemptCount).toBe(0);
    expect(t.timerRef.fn).toBeNull();
    t.fire(); // 已被清理，不应触发
    expect(fired).toEqual([]);
    // 取消后可以重新从头开始
    expect(t.ctrl.schedule()).toBe(true);
    expect(t.timerRef.ms).toBe(1000);
  });

  it("AC-17：pendingInfo 给出剩余秒数（向上取整），逐秒递减", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 3;
    t.ctrl.schedule(); // 1000ms
    expect(t.ctrl.pendingInfo()).toMatchObject({ attempt: 1, max: 3, remainingSec: 1 });
    // 推进 400ms → 剩 600ms → 向上取整 1s
    t.advance(400);
    expect(t.ctrl.pendingInfo()?.remainingSec).toBe(1);
    // 再推进 500ms → 剩 100ms → 1s
    t.advance(500);
    expect(t.ctrl.pendingInfo()?.remainingSec).toBe(1);
    // 到点 → pending 仍为 true（回调由定时器触发）
    t.advance(200);
    expect(t.ctrl.pendingInfo()?.remainingMs).toBe(0);
  });

  it("AC-17：无待执行时 pendingInfo 为 null；触发后清空", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 2;
    expect(t.ctrl.pendingInfo()).toBeNull();
    t.ctrl.schedule();
    expect(t.ctrl.pendingInfo()).not.toBeNull();
    t.fire();
    expect(t.ctrl.pending).toBe(false);
    expect(t.ctrl.pendingInfo()).toBeNull();
  });

  it("onStateChange 在安排/取消/触发时被通知（供 React 同步 UI）", () => {
    const t = forTests();
    const spy = vi.fn();
    t.ctrl.onStateChange = spy;
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 2;
    t.ctrl.schedule();
    expect(spy).toHaveBeenCalledTimes(1);
    t.fire();
    expect(spy).toHaveBeenCalledTimes(2);
    t.ctrl.schedule();
    t.ctrl.cancel();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("dispose() 清理定时器（组件卸载）", () => {
    const t = forTests();
    t.ctrl.enabled = true;
    t.ctrl.maxRetries = 2;
    t.ctrl.schedule();
    t.ctrl.dispose();
    expect(t.timerRef.fn).toBeNull();
    expect(t.ctrl.pending).toBe(false);
  });

  it("真实定时器路径可用（不注入依赖时的默认实现）", () => {
    vi.useFakeTimers();
    const ctrl = new RefreshRetryController();
    ctrl.enabled = true;
    ctrl.maxRetries = 1;
    const fired: number[] = [];
    ctrl.onFire = (n) => fired.push(n);
    expect(ctrl.schedule()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([1]);
    vi.useRealTimers();
  });
});

describe("isWholeRoundFailure：§5 触发条件", () => {
  it("IPC 抛错 → 整轮失败", () => {
    expect(isWholeRoundFailure({ ipcFailed: true, enabledAccountCount: 2, okCount: 0 })).toBe(true);
    expect(isWholeRoundFailure({ ipcFailed: true, enabledAccountCount: 2, okCount: 1 })).toBe(true);
  });

  it("IPC 正常但启用账号 > 0 且全失败 → 整轮失败", () => {
    expect(isWholeRoundFailure({ ipcFailed: false, enabledAccountCount: 3, okCount: 0 })).toBe(true);
  });

  it("AC-15：okCount > 0 的部分失败不触发", () => {
    expect(isWholeRoundFailure({ ipcFailed: false, enabledAccountCount: 3, okCount: 1 })).toBe(false);
    expect(isWholeRoundFailure({ ipcFailed: false, enabledAccountCount: 3, okCount: 2 })).toBe(false);
  });

  it("没有启用账号 → 不算整轮失败（无可重试对象）", () => {
    expect(isWholeRoundFailure({ ipcFailed: false, enabledAccountCount: 0, okCount: 0 })).toBe(false);
    expect(isWholeRoundFailure({ ipcFailed: true, enabledAccountCount: 0, okCount: 0 })).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
