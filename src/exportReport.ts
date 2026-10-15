// R14 报表导出：看板/设置页共用的导出入口（纯前端编排：生成 CSV → 选路径 → 调 Rust 写盘）。
// CSV 文本由 src/reportCsv.ts 生成（含 UTF-8 BOM 与 RFC 4180 转义），Rust 侧只负责原子写入。

import * as api from "./api";
import { buildUsageCsv, defaultCsvFileName } from "./reportCsv";
import type { AccountConfig, BalanceSnapshot, RefreshOutcome } from "./types";

/** 把任意异常转成可读中文提示（Tauri 命令的 Err 通常是字符串，Error 则取 message） */
export function exportErrorMessage(e: unknown): string {
  if (typeof e === "string") {
    const s = e.trim();
    return s === "" ? "未知错误" : s;
  }
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  try {
    const s = String(e).trim();
    return s && s !== "[object Object]" && s !== "null" && s !== "undefined" ? s : "未知错误";
  } catch {
    return "未知错误";
  }
}

export interface ExportUsageCsvOptions {
  /** 只导出这些账号（缺省全部） */
  accountIds?: Iterable<string>;
  /** 覆盖默认文件名（缺省 llm-usage-YYYY-MM-DD.csv） */
  defaultName?: string;
  /** 注入「选路径」实现，便于单测；缺省走原生保存对话框 */
  pickPath?: (defaultName: string) => Promise<string | null>;
  /** 注入「写盘」实现，便于单测；缺省走 export_csv IPC */
  writeFile?: (path: string, content: string) => Promise<void>;
}

export type ExportUsageCsvResult =
  | { status: "exported"; path: string; rowCount: number }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** 数据行数（不含表头与 BOM，供提示文案展示） */
export function countCsvRows(content: string): number {
  const body = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const rows = body.split("\r\n").filter((l) => l !== "");
  return Math.max(0, rows.length - 1);
}

/**
 * 导出用量报表 CSV。全程不抛异常：取消 → cancelled，失败 → error（带可读 message），
 * 由调用方决定如何提示用户。无任何数据行时仍导出（含表头），不静默什么都不做。
 */
export async function exportUsageCsv(
  accounts: readonly AccountConfig[],
  outcomes: readonly RefreshOutcome[],
  snapshots: readonly BalanceSnapshot[],
  options: ExportUsageCsvOptions = {},
): Promise<ExportUsageCsvResult> {
  const pickPath = options.pickPath ?? api.pickCsvExportPath;
  const writeFile = options.writeFile ?? api.exportCsv;
  try {
    const content = buildUsageCsv(accounts, outcomes, snapshots, { accountIds: options.accountIds });
    const path = await pickPath(options.defaultName ?? defaultCsvFileName());
    if (!path) return { status: "cancelled" }; // 用户取消：静默返回
    await writeFile(path, content);
    return { status: "exported", path, rowCount: countCsvRows(content) };
  } catch (e) {
    return { status: "error", message: exportErrorMessage(e) };
  }
}
