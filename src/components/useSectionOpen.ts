// R17 底部报告区块（洞察 / 深度分析）的折叠状态 hook：
// - 默认收起（无记录时 open=false）；
// - localStorage 键 `lsb-bottom-sections`（lsb- 前缀约定，与 notifications/systemNotify 一致），
//   值为 {"insights":boolean,"analysis":boolean}，两个区块各自独立记忆；
// - **只在用户点击头部时写盘**——初始读取绝不写入，避免把「默认收起」误存为用户选择；
// - 读写均 try/catch 兜底（隐私模式 / 存储被禁用时退化为会话内状态）。

import { useCallback, useState } from "react";

export const BOTTOM_SECTIONS_KEY = "lsb-bottom-sections";

export type BottomSectionId = "insights" | "analysis";

type StoredMap = Partial<Record<BottomSectionId, boolean>>;

function readStored(): StoredMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(BOTTOM_SECTIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: StoredMap = {};
      if (typeof obj.insights === "boolean") out.insights = obj.insights;
      if (typeof obj.analysis === "boolean") out.analysis = obj.analysis;
      return out;
    }
  } catch {
    /* 存储不可用 / JSON 损坏：按无记录处理 */
  }
  return {};
}

/**
 * 底部区块折叠状态：返回 [open, toggle]。
 * 初值 = 存储中的用户选择，无记录 → false（收起）。
 */
export function useSectionOpen(section: BottomSectionId): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => readStored()[section] === true);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        if (typeof window !== "undefined") {
          const stored = readStored();
          stored[section] = next;
          window.localStorage.setItem(BOTTOM_SECTIONS_KEY, JSON.stringify(stored));
        }
      } catch {
        /* 写盘失败不影响本次切换 */
      }
      return next;
    });
  }, [section]);

  return [open, toggle];
}
