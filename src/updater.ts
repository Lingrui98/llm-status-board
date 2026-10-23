// R22 一键更新：纯逻辑（状态类型 / 错误文案 / 进度与日期格式化），不依赖 Tauri 插件，便于单测。
//
// 设计见 docs/round-22-updater-plan.md §4：
// - 版本比较与签名校验由 tauri-plugin-updater 在 Rust 侧完成，本模块只做「状态机 + 文案」；
// - 插件接线在 pluginRuntime.ts（动态 import + 降级模式，与 R16 autostart 一致）；
// - 状态归属 App 层，UI 在 SettingsView「关于与更新」区块（本模块不出现任何 React 依赖）。

/** 一次可用更新的展示信息（从插件 Update 对象归一化而来，全字段可安全渲染） */
export interface UpdateInfo {
  /** 新版本号（latest.json 的 version，插件已确认比当前新） */
  version: string;
  /** 发布说明（release body；可能为空串） */
  notes: string;
  /** 发布日期（RFC3339；可能为空串），展示前用 shortUpdateDate 截短 */
  date: string;
}

/** 更新流程状态机（App 层持有；SettingsView 只读渲染） */
export type UpdateState =
  /** 初始 / 静默检查后无事发生 */
  | { kind: "idle" }
  /** 正在检查（手动或静默） */
  | { kind: "checking" }
  /** 已是最新（仅手动检查给出；静默检查不打扰） */
  | { kind: "up-to-date" }
  /** 发现新版本，等待用户点「立即更新」 */
  | { kind: "available"; info: UpdateInfo }
  /** 下载安装中（received 累计字节；total 可能未知为 null） */
  | { kind: "downloading"; info: UpdateInfo; received: number; total: number | null }
  /** 安装完成待重启（macOS 必经；Windows 上 NSIS 接管后通常走不到这里） */
  | { kind: "ready"; info: UpdateInfo }
  /** 失败（phase 区分阶段，文案已可读化；均可重试） */
  | { kind: "error"; phase: "check" | "install"; message: string };

/**
 * 更新能力抽象（App 层注入真实实现 pluginUpdater，测试注入 mock）。
 * 与 R16 AutostartApi / SystemNotifyApi 同一模式。
 */
export interface UpdaterApi {
  /** 检查更新；null = 已是最新。proxy 为 null/空串 → 走系统默认（与「通用设置」的代理共用同一输入） */
  check(proxy: string | null): Promise<UpdateInfo | null>;
  /**
   * 下载并安装已发现的更新（进度回调；total 未知为 null）。
   * 注意：Windows 上 NSIS 安装器接管后**进程直接退出**，本 Promise 可能永远不再返回——
   * 调用方不得把后续逻辑（如「安装成功」提示）放在必须到达的尾调用上。
   */
  downloadAndInstall(onProgress: (received: number, total: number | null) => void): Promise<void>;
  /** 安装完成后重启进新版本（macOS 必须；Windows 一般已被安装器自动重启） */
  relaunch(): Promise<void>;
  /** 兜底：系统浏览器打开 GitHub 发布页（opener 插件，capability 已限定本仓库 releases） */
  openReleasePage(): Promise<void>;
}

/** 「前往发布页」统一入口（手滑改 URL 只改这里） */
export const RELEASES_PAGE_URL = "https://github.com/Lingrui98/llm-status-board/releases/latest";

/**
 * 把插件/网络错误转成可读中文（与 autostartErrorMessage 同风格：不泄露堆栈，且给出下一步）。
 * phase 只影响默认前缀；命中具体原因的文案自带完整语义。
 */
export function updaterErrorMessage(e: unknown, phase: "check" | "install" = "check"): string {
  const raw =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : (() => {
            try {
              return String(e);
            } catch {
              return "";
            }
          })();
  const s = raw.trim();
  const prefix = phase === "check" ? "检查更新失败" : "更新失败";
  if (!s) return `${prefix}（未知原因）`;

  // 更新清单缺失：endpoint 404 —— 首个带 latest.json 的版本发布前属预期（设计 §6「鸡生蛋」）
  if (/404|not ?found|could not fetch|no valid release|empty/i.test(s)) {
    return `${prefix}：暂未获取到更新信息（更新清单可能尚未发布），请稍后重试`;
  }
  // 签名校验失败是安全事件：如实说明「已中止」，并给手动路径（绝不建议关闭校验）
  if (/signature|签名/i.test(s)) {
    return "更新包签名校验失败，已中止安装；请前往发布页手动下载安装包";
  }
  // 网络类失败：本项目用户常需代理访问 GitHub，提示与「通用设置」的代理联动
  if (
    /error sending request|dns|timed? ?out|connect|network|unreachable|refused|reset|tls|ssl|certificate|proxy/i.test(
      s,
    )
  ) {
    return `${prefix}：网络请求失败（${s}）；可检查「通用设置」中的网络代理`;
  }
  // macOS 覆盖 /Applications 无权限是安装阶段最常见平台失败
  if (/permission|denied|access/i.test(s)) {
    return `${prefix}：没有写入权限（${s}）；可前往发布页手动下载安装`;
  }
  return `${prefix}：${s}`;
}

/** 字节数格式化（<1KB 用 B，<1MB 用 KB，否则 MB 保留一位小数；非法输入归 0） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下载进度文案（total 未知 → 只报已下载量，不编造百分比） */
export function formatProgress(received: number, total: number | null): string {
  return total !== null && total > 0
    ? `正在下载 ${formatBytes(received)} / ${formatBytes(total)}…`
    : `正在下载，已下载 ${formatBytes(received)}…`;
}

/** latest.json 的 RFC3339 发布日期 → 「YYYY-MM-DD」（取不出 → 空串，调用方省略日期） */
export function shortUpdateDate(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
  return m ? m[1] : "";
}

/** 是否处于更新流程进行中（「检查更新 / 立即更新」按钮的禁用判定） */
export function isUpdateBusy(state: UpdateState): boolean {
  return state.kind === "checking" || state.kind === "downloading";
}
