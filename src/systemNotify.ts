// R16 §4 系统通知：防打扰判定（纯函数 + 可注入 now/state）与实际发送的薄封装。
//
// 三条规则（docs/round-16-plan.md §4，按下单顺序判定，全部满足才发送）：
//   1) 只推新问题：该 problemKey 本轮从「不存在」变为「存在」才考虑；持续存在不重复推；
//   2) 24h 抑制：now − lastSentAt(kind:accountId) ≥ 86_400_000ms 才推；
//   3) 速率上限：近 RATE_WINDOW_MS(300_000) 内已发送 < 3 条才推；
//      被本条丢弃的通知**不写抑制表、不计入速率计数**，也**不补发**（防打扰优先）。
//
// 权限边界：未授权且用户未开启开关时**不请求权限、不发送**；开启开关才请求一次。

import { KIND_LABELS, problemKey } from "./notifications";
import type { NotificationKind } from "./notifications";

/**
 * 系统通知只覆盖这三类（`recovered` 不推送，§4）。
 *
 * 类型选择说明：这里**刻意**标注为 `readonly NotificationKind[]`，而不是用
 * `as const satisfies readonly NotificationKind[]`。原因是后者保留字面量元组类型时，
 * `includes(x)` 的参数会被收窄成三个字面量的联合，从 `string` 判定时只能写无依据的
 * 双重断言。标注成数组类型后，`includes` 的参数就是 `NotificationKind`，
 * 调用处只需一次集中且有依据的成员判定（见下方 `isSystemNotifyKind`）。
 */
export const SYSTEM_NOTIFY_KINDS: readonly NotificationKind[] = ["lowBalance", "quotaFull", "refreshError"];

/**
 * 字符串 → 是否属于系统通知三类。
 * 用 `Set<string>.has` 做判定：既没有类型断言，也不依赖 `Array.includes` 的参数收窄，
 * 是「字符串集合成员判断」最直白的写法。
 */
export function isSystemNotifyKind(kind: string | null | undefined): boolean {
  return !!kind && SYSTEM_NOTIFY_KIND_SET.has(kind);
}

const SYSTEM_NOTIFY_KIND_SET: ReadonlySet<string> = new Set<string>(SYSTEM_NOTIFY_KINDS);

/** 24h 抑制窗口 */
export const NOTIFY_SUPPRESS_MS = 86_400_000;
/** 速率窗口 */
export const RATE_WINDOW_MS = 300_000;
/** 速率窗口内允许的最大发送条数 */
export const RATE_MAX_IN_WINDOW = 3;
/** 正文长度上限（超出截断补「…」） */
export const NOTIFY_BODY_MAX = 200;

/** 抑制表 + 速率计数（运行态，存 localStorage，不进配置） */
export interface SystemNotifyState {
  /** `${kind}:${accountId}` → 上次成功发送的 epochMs */
  sentAt: Record<string, number>;
  /** 最近成功发送的时刻列表（epochMs，升序无要求，判定时过滤窗口） */
  rate: number[];
}

export interface SystemNotifySource {
  kind: NotificationKind;
  accountId: string;
  accountName: string;
  /** 正文里的关键数值文本（余额+阈值 / 窗口+百分比 / 错误原因） */
  detail: string;
  /** 本轮该账号该类型的问题是否存在（false = 已恢复 → 不推，§4） */
  active: boolean;
}

export type SystemNotifySkipReason = "notSystemKind" | "notNew" | "disabled" | "suppressed" | "rateLimited";

export interface SystemNotifyDecision {
  send: boolean;
  /** 通知标题（类别中文名） */
  title: string;
  /** 通知正文（已按 200 字符截断） */
  body: string;
  /** 抑制表键 */
  key: string;
  /** 未发送原因（send=false 时给出，便于测试与调试） */
  skipReason?: SystemNotifySkipReason;
}

/** 截断到 200 字符（超出补「…」，总长 ≤ 200） */
export function truncateBody(text: string, max: number = NOTIFY_BODY_MAX): string {
  const t = text ?? "";
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** 组装通知正文：账号名 + 关键数值，超长截断 */
export function buildNotifyBody(accountName: string, detail: string): string {
  const tail = (detail ?? "").trim();
  return truncateBody(tail ? `${accountName}：${tail}` : accountName);
}

function isSystemKind(kind: NotificationKind): boolean {
  // 类型已被标注为 readonly NotificationKind[]，无需再断言
  return SYSTEM_NOTIFY_KINDS.includes(kind);
}

/** 窗口内已成功发送的条数（不含窗口外的历史） */
export function rateCountInWindow(state: SystemNotifyState, now: number): number {
  return state.rate.filter((t) => Number.isFinite(t) && now - t < RATE_WINDOW_MS).length;
}

/**
 * 判定单条问题是否应发系统通知（纯函数，不产生副作用）。
 * @param activeProblemKeys 本轮仍存在的问题键集合；只有「本轮存在」才可能推
 * @param prevProblemKeys 上一轮存在的问题键集合；用于「从不存在变为存在」的新问题判定
 */
export function shouldSendSystemNotification(
  source: SystemNotifySource,
  opts: {
    now: number;
    enabled: boolean;
    state: SystemNotifyState;
    /** 上一轮的问题键集合（null = 首轮，视为全部为新） */
    prevProblemKeys?: ReadonlySet<string> | null;
  },
): SystemNotifyDecision {
  const key = problemKey(source.kind, source.accountId);
  const title = KIND_LABELS[source.kind] ?? source.kind;
  const body = buildNotifyBody(source.accountName, source.detail);
  const base = { title, body, key };

  // 非三类之一（如 recovered）→ 永不推送
  if (!isSystemKind(source.kind)) return { ...base, send: false, skipReason: "notSystemKind" };
  // 已恢复/已解决 → 不推
  if (!source.active) return { ...base, send: false, skipReason: "notNew" };
  // 开关关闭 → 不请求权限、不发送
  if (!opts.enabled) return { ...base, send: false, skipReason: "disabled" };

  // 规则 1：只推新问题（首轮 prev=null 时全部视为新）
  const wasPresent = opts.prevProblemKeys ? opts.prevProblemKeys.has(key) : false;
  if (wasPresent) return { ...base, send: false, skipReason: "notNew" };

  // 规则 2：24h 抑制
  const last = opts.state.sentAt[key];
  if (typeof last === "number" && Number.isFinite(last) && opts.now - last < NOTIFY_SUPPRESS_MS) {
    return { ...base, send: false, skipReason: "suppressed" };
  }

  // 规则 3：速率上限
  if (rateCountInWindow(opts.state, opts.now) >= RATE_MAX_IN_WINDOW) {
    return { ...base, send: false, skipReason: "rateLimited" };
  }

  return { ...base, send: true };
}

/**
 * 发送**成功后**更新状态：写抑制表 + 追加速率计数，并丢弃出窗的计数。
 * 被丢弃的通知不得调用本函数（否则会永久占额，§4 规则 3）。
 */
export function commitSystemNotify(
  state: SystemNotifyState,
  key: string,
  now: number,
): SystemNotifyState {
  const sentAt = { ...state.sentAt, [key]: now };
  // 抑制表修剪：只保留 24h 内的键，避免长期膨胀
  const pruned: Record<string, number> = {};
  for (const [k, t] of Object.entries(sentAt)) {
    if (typeof t === "number" && Number.isFinite(t) && now - t < NOTIFY_SUPPRESS_MS) pruned[k] = t;
  }
  return { sentAt: pruned, rate: [...state.rate.filter((t) => now - t < RATE_WINDOW_MS), now] };
}

/** 空状态 */
export function emptySystemNotifyState(): SystemNotifyState {
  return { sentAt: {}, rate: [] };
}

/* ---------- localStorage 持久化（只存抑制表与速率计数，不进配置） ---------- */

/** localStorage 键（lsb- 前缀，与通知已读映射同一约定） */
export const SYSTEM_NOTIFY_STORAGE_KEY = "lsb-sysnotify";

export function loadSystemNotifyState(storage?: { getItem(k: string): string | null }): SystemNotifyState {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!store) return emptySystemNotifyState();
    const raw = store.getItem(SYSTEM_NOTIFY_STORAGE_KEY);
    if (!raw) return emptySystemNotifyState();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySystemNotifyState();
    const obj = parsed as { sentAt?: unknown; rate?: unknown };
    const sentAt: Record<string, number> = {};
    if (obj.sentAt && typeof obj.sentAt === "object" && !Array.isArray(obj.sentAt)) {
      for (const [k, v] of Object.entries(obj.sentAt as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) sentAt[k] = v;
      }
    }
    const rate = Array.isArray(obj.rate)
      ? obj.rate.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      : [];
    return { sentAt, rate };
  } catch {
    return emptySystemNotifyState(); // 存储不可用/损坏 → 从空状态开始，不阻塞
  }
}

export function saveSystemNotifyState(
  state: SystemNotifyState,
  storage?: { setItem(k: string, v: string): void },
): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!store) return;
    store.setItem(SYSTEM_NOTIFY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时仅本次会话生效
  }
}
