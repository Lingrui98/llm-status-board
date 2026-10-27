import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginUpdater } from "./pluginRuntime";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  Update: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ Update: mocks.Update }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

function metadata(version = "0.2.11-nightly.20261027.1") {
  return {
    rid: 7,
    currentVersion: "0.2.11",
    version,
    date: null,
    body: null,
    rawJson: { version },
  };
}

beforeEach(async () => {
  // 释放上一个用例留下的真实模块级待安装句柄。
  mocks.invoke.mockResolvedValue(null);
  await pluginUpdater.check(null, "stable");
  vi.clearAllMocks();
  mocks.invoke.mockReset();
  mocks.Update.mockReset();
  mocks.openUrl.mockReset();
});

describe("pluginUpdater 渠道检查", () => {
  it("把 nightly、代理和超时传给 Rust，并构造官方 Update 句柄", async () => {
    const meta = metadata();
    const handle = { ...meta, close: vi.fn(), downloadAndInstall: vi.fn() };
    mocks.invoke.mockResolvedValue(meta);
    mocks.Update.mockImplementation(() => handle);

    const info = await pluginUpdater.check(" http://127.0.0.1:7890 ", "nightly");

    expect(mocks.invoke).toHaveBeenCalledWith("check_channel_update", {
      channel: "nightly",
      proxy: "http://127.0.0.1:7890",
      timeout: 15_000,
    });
    expect(mocks.Update).toHaveBeenCalledWith({ ...meta, date: undefined, body: undefined });
    expect(info).toEqual({ version: meta.version, notes: "", date: "" });
  });

  it("空白代理归一为 null，无更新时不构造句柄", async () => {
    mocks.invoke.mockResolvedValue(null);

    await expect(pluginUpdater.check("  ", "stable")).resolves.toBeNull();

    expect(mocks.invoke).toHaveBeenCalledWith("check_channel_update", {
      channel: "stable",
      proxy: null,
      timeout: 15_000,
    });
    expect(mocks.Update).not.toHaveBeenCalled();
  });

  it("切换渠道后再次检查会关闭旧渠道句柄", async () => {
    const meta = metadata();
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.Update.mockImplementation(() => ({ ...meta, close, downloadAndInstall: vi.fn() }));
    mocks.invoke.mockResolvedValueOnce(meta).mockResolvedValueOnce(null);

    await pluginUpdater.check(null, "nightly");
    await pluginUpdater.check(null, "stable");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("手动发布页与所选渠道一致", async () => {
    mocks.openUrl.mockResolvedValue(undefined);

    await pluginUpdater.openReleasePage("nightly");
    await pluginUpdater.openReleasePage("stable");

    expect(mocks.openUrl).toHaveBeenNthCalledWith(
      1,
      "https://github.com/Lingrui98/llm-status-board/releases/tag/nightly",
    );
    expect(mocks.openUrl).toHaveBeenNthCalledWith(
      2,
      "https://github.com/Lingrui98/llm-status-board/releases/latest",
    );
  });
});
