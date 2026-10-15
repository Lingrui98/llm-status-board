// R16 §2 开机自启：插件薄封装（真值以系统为准，不做乐观更新）。
//
// 规格要求（docs/round-16-plan.md §2）：
// - 默认关；打开设置页时查询 `isEnabled()` 真实状态，查询中开关禁用；
// - 切换：`enable()/disable()` 成功后**再次查询**确认，据此渲染；
// - 命令失败 → 调用方把开关回置为查询到的真实值 + 显示可读原因，绝不显示"已开启"但实际未生效。

export interface AutostartApi {
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

/** 把插件/系统错误转成可读中文（不泄露原始堆栈，也不吞掉原因） */
export function autostartErrorMessage(e: unknown): string {
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
  if (!s) return "开机自启设置失败（未知原因）";
  // 平台不支持是最常见的失败原因，单独给一句用户能理解的话
  if (/not.?supported|unsupported|only available|linux/i.test(s)) {
    return `当前系统不支持开机自启（${s}）`;
  }
  if (/permission|denied|access/i.test(s)) {
    return `没有权限设置开机自启（${s}）`;
  }
  return `开机自启设置失败：${s}`;
}

export interface AutostartToggleResult {
  /** 操作后**再次查询**到的真实状态（失败时即回滚目标值） */
  enabled: boolean;
  /** 操作是否成功 */
  ok: boolean;
  /** 失败时的可读原因 */
  error?: string;
}

/**
 * 切换自启并确认真实状态（§2）：
 * 1) 调用 enable/disable；2) **无论成败都再查一次** `isEnabled()`；
 * 3) 查询本身失败 → 视作操作失败并给出可读原因（宁可显示失败也不谎报成功）。
 */
export async function toggleAutostart(api: AutostartApi, wantEnabled: boolean): Promise<AutostartToggleResult> {
  let failure: unknown = null;
  try {
    if (wantEnabled) await api.enable();
    else await api.disable();
  } catch (e) {
    failure = e;
  }
  try {
    const actual = await api.isEnabled();
    if (failure !== null) return { enabled: actual, ok: false, error: autostartErrorMessage(failure) };
    if (actual !== wantEnabled) {
      // 命令没报错但状态没变（部分平台静默失败）→ 如实报告不一致
      return {
        enabled: actual,
        ok: false,
        error: wantEnabled ? "系统未接受开机自启设置" : "系统未取消开机自启",
      };
    }
    return { enabled: actual, ok: true };
  } catch (e) {
    return {
      enabled: !wantEnabled, // 查询失败：回置为操作前的值（保守，不谎报成功）
      ok: false,
      error: failure !== null ? autostartErrorMessage(failure) : autostartErrorMessage(e),
    };
  }
}
