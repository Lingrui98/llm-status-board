// R16 task-27：权限被拒提示的**文案诚实性** —— 平台判定与手动放行路径。
// 纯字符串输入，断言不依赖运行机器平台。

import { describe, expect, it } from "vitest";
import { NOTIFY_PERMISSION_RETRY_LABEL, detectPlatform, notificationManualPath } from "./pluginRuntime";

describe("detectPlatform：按 userAgent 判定（不依赖运行机器）", () => {
  it("Windows 各版本 UA", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (WINDOWS NT 6.1)")).toBe("windows");
  });

  it("macOS UA（含 WebKit 的 Macintosh 与 Tauri 的 Darwin 两种写法）", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macos");
    expect(detectPlatform("SomeRuntime/1.0 (darwin)")).toBe("macos");
  });

  it("Linux 与未知平台", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectPlatform("")).toBe("other");
    expect(detectPlatform("Weird/1.0")).toBe("other");
  });
});

describe("notificationManualPath：手动放行路径必须可操作", () => {
  it("Windows 给出「设置 → 系统 → 通知」路径", () => {
    const text = notificationManualPath("windows");
    expect(text).toContain("Windows 设置");
    expect(text).toContain("系统");
    expect(text).toContain("通知");
    expect(text).toContain("LLM Status Board");
  });

  it("macOS 给出「系统设置 → 通知」路径", () => {
    const text = notificationManualPath("macos");
    expect(text).toContain("macOS 系统设置");
    expect(text).toContain("通知");
    expect(text).toContain("LLM Status Board");
  });

  it("Linux 与未知平台也有可读指引（不出现空白/占位符）", () => {
    for (const p of ["linux", "other", "随便什么"]) {
      const text = notificationManualPath(p);
      expect(text.length).toBeGreaterThan(10);
      expect(text).toContain("通知");
      expect(text).not.toContain("undefined");
    }
  });

  it("不传参数时按当前环境判定（jsdom 下也有兜底文案）", () => {
    const text = notificationManualPath();
    expect(text.length).toBeGreaterThan(10);
    expect(text).toContain("通知");
  });
});

describe("NOTIFY_PERMISSION_RETRY_LABEL：按钮文案如实描述行为", () => {
  it("不再是「去授权」，而是「重新请求授权」", () => {
    expect(NOTIFY_PERMISSION_RETRY_LABEL).toBe("重新请求授权");
    expect(NOTIFY_PERMISSION_RETRY_LABEL).not.toBe("去授权");
    // 不暗示能打开系统设置
    expect(NOTIFY_PERMISSION_RETRY_LABEL).not.toContain("系统设置");
  });
});
