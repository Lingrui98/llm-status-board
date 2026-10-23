// R22 一键更新纯逻辑测试（docs/round-22-updater-plan.md §6）：
// 状态机判定、错误文案分支（404 / 网络 / 签名 / 权限 / 兜底）、进度与日期格式化。
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatProgress,
  isUpdateBusy,
  shortUpdateDate,
  updaterErrorMessage,
  type UpdateState,
} from "./updater";

describe("updaterErrorMessage", () => {
  it("空错误 → 阶段前缀 + 未知原因", () => {
    expect(updaterErrorMessage("", "check")).toBe("检查更新失败（未知原因）");
    expect(updaterErrorMessage(new Error("  "), "install")).toBe("更新失败（未知原因）");
  });

  it("404 / 清单缺失 → 「尚未发布」的可等待答复", () => {
    expect(updaterErrorMessage(new Error("error status 404: Not Found"), "check")).toContain("更新清单可能尚未发布");
    expect(updaterErrorMessage("Could not fetch a valid release JSON from the remote", "check")).toContain(
      "请稍后重试",
    );
  });

  it("签名校验失败 → 如实说明已中止 + 手动路径（不论阶段）", () => {
    const msg = updaterErrorMessage(new Error("invalid signature for the update archive"), "install");
    expect(msg).toContain("签名校验失败");
    expect(msg).toContain("已中止");
    expect(msg).toContain("手动下载");
  });

  it("网络类失败 → 提示检查代理（本项目用户常需代理访问 GitHub）", () => {
    expect(updaterErrorMessage(new Error("error sending request for url"), "check")).toContain("网络代理");
    expect(updaterErrorMessage(new Error("connection timed out"), "check")).toContain("网络代理");
    expect(updaterErrorMessage(new Error("dns error: failed to lookup address"), "install")).toContain("网络代理");
  });

  it("权限失败 → 给手动安装路径", () => {
    const msg = updaterErrorMessage(new Error("Permission denied (os error 13)"), "install");
    expect(msg).toContain("没有写入权限");
    expect(msg).toContain("手动下载");
  });

  it("兜底：保留原始原因（不吞错），带阶段前缀", () => {
    expect(updaterErrorMessage(new Error("磁盘已满"), "install")).toBe("更新失败：磁盘已满");
    expect(updaterErrorMessage("自定义错误", "check")).toBe("检查更新失败：自定义错误");
  });

  it("非 Error 异常（字符串 / 对象）也能读出原因", () => {
    expect(updaterErrorMessage("network unreachable", "check")).toContain("网络代理");
    expect(updaterErrorMessage({ toString: () => "404 bad" }, "check")).toContain("更新清单可能尚未发布");
  });
});

describe("formatBytes", () => {
  it("分级：B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("非法输入归 0，不抛错", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatProgress", () => {
  it("total 已知 → 显示 已下载/总量", () => {
    expect(formatProgress(1024 * 1024, 3 * 1024 * 1024)).toBe("正在下载 1.0 MB / 3.0 MB…");
  });

  it("total 未知（null/0）→ 只报已下载量，不编造百分比", () => {
    expect(formatProgress(512 * 1024, null)).toBe("正在下载，已下载 512 KB…");
    expect(formatProgress(512 * 1024, 0)).toBe("正在下载，已下载 512 KB…");
  });
});

describe("shortUpdateDate", () => {
  it("RFC3339 → YYYY-MM-DD", () => {
    expect(shortUpdateDate("2026-10-23T07:43:01Z")).toBe("2026-10-23");
    expect(shortUpdateDate("2026-10-23 07:43:01 +08:00")).toBe("2026-10-23");
  });

  it("取不出日期 → 空串（调用方省略展示）", () => {
    expect(shortUpdateDate("")).toBe("");
    expect(shortUpdateDate("soon")).toBe("");
  });
});

describe("isUpdateBusy", () => {
  const cases: [UpdateState, boolean][] = [
    [{ kind: "idle" }, false],
    [{ kind: "checking" }, true],
    [{ kind: "up-to-date" }, false],
    [{ kind: "available", info: { version: "1.0.0", notes: "", date: "" } }, false],
    [{ kind: "downloading", info: { version: "1.0.0", notes: "", date: "" }, received: 0, total: null }, true],
    [{ kind: "ready", info: { version: "1.0.0", notes: "", date: "" } }, false],
    [{ kind: "error", phase: "check", message: "x" }, false],
  ];

  it.each(cases)("%s → busy=%s", (state, expected) => {
    expect(isUpdateBusy(state)).toBe(expected);
  });
});
