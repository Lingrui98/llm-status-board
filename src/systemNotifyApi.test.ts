// R16 §4 发送薄封装单测：权限边界（未授权不发送、仅在允许时请求一次、拒绝后不再请求）与静默降级。

import { describe, expect, it, vi } from "vitest";
import { querySystemNotifyPermission, sendSystemNotify, type SystemNotifyApi } from "./systemNotifyApi";
import { toggleAutostart, autostartErrorMessage, type AutostartApi } from "./autostart";

function notifyApi(patch: Partial<SystemNotifyApi> = {}): SystemNotifyApi {
  return {
    isPermissionGranted: patch.isPermissionGranted ?? (async () => true),
    requestPermission: patch.requestPermission ?? (async () => "granted"),
    sendNotification: patch.sendNotification ?? vi.fn(),
  };
}

const payload = { title: "余额不足", body: "甲账号：余额 0.50 USD" };

describe("sendSystemNotify：权限边界", () => {
  it("已授权 → 直接发送一次", async () => {
    const send = vi.fn();
    const res = await sendSystemNotify(notifyApi({ sendNotification: send }), payload, false);
    expect(res).toEqual({ sent: true, permission: "granted" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(payload);
  });

  it("未授权且不允许请求 → 不请求、不发送", async () => {
    const request = vi.fn(async () => "granted" as const);
    const send = vi.fn();
    const res = await sendSystemNotify(
      notifyApi({ isPermissionGranted: async () => false, requestPermission: request, sendNotification: send }),
      payload,
      false,
    );
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe("notGranted");
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("未授权且允许请求 → 请求一次；授权后发送", async () => {
    const request = vi.fn(async () => "granted" as const);
    const send = vi.fn();
    const res = await sendSystemNotify(
      notifyApi({ isPermissionGranted: async () => false, requestPermission: request, sendNotification: send }),
      payload,
      true,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sent: true, permission: "granted" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("请求被拒 → 不发送、permission=denied（调用方据此只提示一次）", async () => {
    const send = vi.fn();
    const res = await sendSystemNotify(
      notifyApi({
        isPermissionGranted: async () => false,
        requestPermission: async () => "denied",
        sendNotification: send,
      }),
      payload,
      true,
    );
    expect(res).toEqual({ sent: false, permission: "denied", skipped: "notGranted" });
    expect(send).not.toHaveBeenCalled();
  });

  it("requestPermission 抛错 → 静默降级为 denied，不抛出", async () => {
    await expect(
      sendSystemNotify(
        notifyApi({
          isPermissionGranted: async () => false,
          requestPermission: async () => {
            throw new Error("no notification service");
          },
        }),
        payload,
        true,
      ),
    ).resolves.toEqual({ sent: false, permission: "denied", skipped: "notGranted" });
  });

  it("AC-13：sendNotification 抛错（平台无通知守护）→ 静默降级，不重试、不抛出", async () => {
    const send = vi.fn(() => {
      throw new Error("no daemon");
    });
    const res = await sendSystemNotify(notifyApi({ sendNotification: send }), payload, false);
    expect(res.sent).toBe(false);
    expect(res.permission).toBe("granted");
    expect(send).toHaveBeenCalledTimes(1); // 不重试
  });

  it("isPermissionGranted 抛错 → 视作未授权，不崩", async () => {
    const res = await sendSystemNotify(
      notifyApi({
        isPermissionGranted: async () => {
          throw new Error("boom");
        },
      }),
      payload,
      true,
    );
    expect(res.sent).toBe(false);
    expect(res.permission).toBe("unknown");
  });
});

describe("querySystemNotifyPermission", () => {
  it("授权 / 未授权 / 查询失败三种结果", async () => {
    expect(await querySystemNotifyPermission(notifyApi({ isPermissionGranted: async () => true }))).toBe("granted");
    expect(await querySystemNotifyPermission(notifyApi({ isPermissionGranted: async () => false }))).toBe("denied");
    expect(
      await querySystemNotifyPermission(
        notifyApi({
          isPermissionGranted: async () => {
            throw new Error("x");
          },
        }),
      ),
    ).toBe("unknown");
  });
});

/* ---------------- §2 自启切换的诚实性 ---------------- */

function autoApi(patch: Partial<AutostartApi> = {}): AutostartApi {
  return {
    isEnabled: patch.isEnabled ?? (async () => false),
    enable: patch.enable ?? (async () => {}),
    disable: patch.disable ?? (async () => {}),
  };
}

describe("toggleAutostart：命令失败必须回滚真实状态", () => {
  it("成功开启 → 再次查询确认后返回 ok", async () => {
    let enabled = false;
    const api = autoApi({
      isEnabled: async () => enabled,
      enable: async () => {
        enabled = true;
      },
    });
    await expect(toggleAutostart(api, true)).resolves.toEqual({ enabled: true, ok: true });
  });

  it("成功关闭 → 再次查询确认后返回 ok", async () => {
    let enabled = true;
    const api = autoApi({
      isEnabled: async () => enabled,
      disable: async () => {
        enabled = false;
      },
    });
    await expect(toggleAutostart(api, false)).resolves.toEqual({ enabled: false, ok: true });
  });

  it("enable 抛错（系统不支持）→ 回置为查询到的真实值 + 可读原因（不显示已开启）", async () => {
    const api = autoApi({
      isEnabled: async () => false, // 真实状态仍是关
      enable: async () => {
        throw new Error("autostart is only available on macOS and Windows");
      },
    });
    const res = await toggleAutostart(api, true);
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(false); // 关键：不谎报成功
    expect(res.error).toContain("当前系统不支持开机自启");
  });

  it("disable 抛错 → 回置为真实值（仍为开）", async () => {
    const api = autoApi({
      isEnabled: async () => true,
      disable: async () => {
        throw "permission denied";
      },
    });
    const res = await toggleAutostart(api, false);
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(true);
    expect(res.error).toContain("没有权限");
  });

  it("命令没报错但状态未变 → 如实报告不一致（部分平台静默失败）", async () => {
    const api = autoApi({ isEnabled: async () => false, enable: async () => {} });
    const res = await toggleAutostart(api, true);
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(false);
    expect(res.error).toContain("系统未接受");
  });

  it("复查查询本身失败 → 视作失败并回置为操作前的值", async () => {
    const api = autoApi({
      isEnabled: async () => {
        throw new Error("query failed");
      },
    });
    const res = await toggleAutostart(api, true);
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(false); // 回置为 !want
    expect(res.error).toBeTruthy();
  });
});

describe("autostartErrorMessage", () => {
  it("平台不支持 / 无权限 / 其它错误都给可读中文", () => {
    expect(autostartErrorMessage("autostart is not supported")).toContain("当前系统不支持开机自启");
    expect(autostartErrorMessage("Access denied")).toContain("没有权限");
    expect(autostartErrorMessage("boom")).toContain("开机自启设置失败：boom");
    expect(autostartErrorMessage("")).toContain("未知原因");
    expect(autostartErrorMessage(new Error("some failure"))).toContain("some failure");
  });
});
