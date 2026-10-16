// R16 §5 刷新失败自动重试：指数退避状态机（纯逻辑 + 可注入定时器，便于单测）。
//
// 规则（严格照 docs/round-16-plan.md §5）：
// - 最多 `maxRetries` 次；第 k 次重试前等待 `1000 × 2^(k−1)` ms → 1s / 2s / 4s（max=3 累计 7s）；
// - `enabled=false` 或 `maxRetries=0` → 从不重试；
// - 任一时刻**最多一个**待执行定时器；`cancel()` 清定时器并把计数归零；
// - 重试本身失败**不再产生新的重试链**（由下一次手动/定时刷新重新开始）；
// - 等待期提供剩余秒数供 UI 显示「刷新失败，Ns 后重试（第 k/N 次）」。

/** 第 k 次重试（k 从 1 起）前的等待毫秒数 */
export function retryDelayMs(attempt: number): number {
  const k = Math.max(1, Math.trunc(attempt));
  return 1000 * 2 ** (k - 1);
}

/** 供 UI 展示的重试提示 */
export interface RetryPendingInfo {
  /** 第几次重试（1 起） */
  attempt: number;
  /** 次数上限 */
  max: number;
  /** 剩余毫秒（向上取整到秒用于展示） */
  remainingMs: number;
  /** 剩余秒数（向上取整；UI 显示「Ns 后重试」） */
  remainingSec: number;
}

interface RetryDeps {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

/**
 * 刷新失败自动重试控制器。
 * 用法：整轮失败 → `schedule()`；成功/手动刷新 → `cancel()`。
 */
export class RefreshRetryController {
  private timerId: number | null = null;
  private attempt = 0; // 已安排/已执行的第几次
  private deadline = 0; // 本次等待的到点时刻
  private running = false; // 定时器是否待执行
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (id: number) => void;

  maxRetries = 0;
  enabled = false;
  /** 到点回调：参数是第几次重试（1 起） */
  onFire: ((attempt: number) => void) | null = null;
  /** 状态变化回调（供 React 同步 UI） */
  onStateChange: (() => void) | null = null;

  constructor(deps: RetryDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));
  }

  /** 是否启用重试（enabled 且 maxRetries ≥ 1） */
  get active(): boolean {
    return this.enabled && this.maxRetries >= 1;
  }

  /** 是否有待执行的重试 */
  get pending(): boolean {
    return this.running;
  }

  /** 已安排的重试次数（等待中的那次也算） */
  get attemptCount(): number {
    return this.attempt;
  }

  /**
   * 整轮失败后调用。返回是否真的安排了重试。
   * - 未启用/次数用尽 → 不安排并返回 false（调用方据此"如实报失败"）；
   * - 已有待执行定时器 → 不重复安排（保证「任一时刻最多一个」）。
   */
  schedule(): boolean {
    if (!this.active) return false;
    if (this.running) return false; // 已有待执行重试，绝不叠加
    if (this.attempt >= this.maxRetries) return false; // 达到上限
    this.attempt += 1;
    const delay = retryDelayMs(this.attempt);
    this.deadline = this.now() + delay;
    this.running = true;
    const attemptAtFire = this.attempt;
    this.timerId = this.setT(() => {
      this.timerId = null;
      this.running = false;
      this.onStateChange?.();
      // 重试本身不再 schedule（由调用方在失败后再次调用 schedule 时受 attempt 上限约束）
      this.onFire?.(attemptAtFire);
    }, delay);
    this.onStateChange?.();
    return true;
  }

  /** 取消待执行的重试并把退避计数归零（手动刷新 / 成功） */
  cancel(): void {
    if (this.timerId !== null) {
      this.clearT(this.timerId);
      this.timerId = null;
    }
    const had = this.running || this.attempt !== 0;
    this.running = false;
    this.attempt = 0;
    this.deadline = 0;
    if (had) this.onStateChange?.();
  }

  /** 当前待执行重试的展示信息；无待执行 → null */
  pendingInfo(): RetryPendingInfo | null {
    if (!this.running) return null;
    const remainingMs = Math.max(0, this.deadline - this.now());
    return {
      attempt: this.attempt,
      max: this.maxRetries,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
    };
  }

  /** 组件卸载时清理 */
  dispose(): void {
    if (this.timerId !== null) {
      this.clearT(this.timerId);
      this.timerId = null;
    }
    this.running = false;
    this.attempt = 0;
  }
}

/**
 * 整轮失败判定（§5 触发条件）：
 * `refresh_all` 抛错/Err，**或**（启用账号数 > 0 且 okCount === 0）。
 * `okCount > 0` 的部分失败**不重试**（避免放大请求量）。
 */
export function isWholeRoundFailure(opts: {
  /** IPC 是否抛错/返回 Err */
  ipcFailed: boolean;
  enabledAccountCount: number;
  okCount: number;
}): boolean {
  if (opts.enabledAccountCount <= 0) return false; // 没有启用账号就无所谓"整轮失败"
  if (opts.ipcFailed) return true;
  return opts.okCount === 0;
}
