// R24：悬停浮层尺寸的持久化与钳制（纯逻辑，便于单测）。
//
// 存储：localStorage（桌面 WebView 持久；与主窗口共享 origin，键名带 lsb-summary- 前缀隔离）。
// 钳制下限与 tauri.conf.json 的 minWidth/minHeight（260×300）一致，上限 1200 防误拖出巨型窗口；
// 读不到/读坏了 → null（用 tauri.conf.json 的默认 300×360），绝不抛错。

export const SUMMARY_MIN_WIDTH = 260;
export const SUMMARY_MIN_HEIGHT = 300;
export const SUMMARY_DEFAULT_WIDTH = 300;
export const SUMMARY_DEFAULT_HEIGHT = 360;
/** 防误拖上限（浮层是速览工具，超出此尺寸没有意义） */
export const SUMMARY_MAX_SIDE = 1200;

const KEY = "lsb-summary-size";

export interface SummarySize {
  width: number;
  height: number;
}

/** 钳制到 [min, max] 并取整；非有限值/0 → 默认尺寸 */
export function clampSummarySize(width: number, height: number): SummarySize {
  const w = Number.isFinite(width) ? Math.round(width) : 0;
  const h = Number.isFinite(height) ? Math.round(height) : 0;
  return {
    width: Math.min(SUMMARY_MAX_SIDE, Math.max(SUMMARY_MIN_WIDTH, w || SUMMARY_DEFAULT_WIDTH)),
    height: Math.min(SUMMARY_MAX_SIDE, Math.max(SUMMARY_MIN_HEIGHT, h || SUMMARY_DEFAULT_HEIGHT)),
  };
}

/** 读取持久化尺寸；缺失/损坏 → null（调用方回落默认） */
export function loadSummarySize(storage?: Pick<Storage, "getItem"> | null): SummarySize | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    if (!raw) return null;
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    const { w, h } = j as { w?: unknown; h?: unknown };
    if (typeof w !== "number" || typeof h !== "number") return null;
    return clampSummarySize(w, h);
  } catch {
    return null;
  }
}

/** 持久化尺寸（先钳制；存储不可用时静默——本次会话内生效即可） */
export function saveSummarySize(width: number, height: number, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const s = clampSummarySize(width, height);
    (storage ?? window.localStorage).setItem(KEY, JSON.stringify({ w: s.width, h: s.height }));
  } catch {
    // 存储不可用：不阻塞调整
  }
}
