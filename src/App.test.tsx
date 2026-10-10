import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import App from "./App";
import type { AppConfig, RefreshOutcome } from "./types";

afterEach(cleanup);

// mock Tauri IPC 层
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

function makeConfig(accounts: AppConfig["accounts"]): AppConfig {
  return {
    version: 1,
    settings: { autoRefreshSec: 0, refreshOnStart: false, proxy: null },
    accounts,
  };
}

const dsAccount = {
  id: "acc-ds",
  name: "DeepSeek 官方",
  kind: "deepSeek" as const,
  enabled: true,
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-x",
  token: "",
  refreshToken: "",
  userId: null,
  username: "",
  password: "",
  quotaPerUnit: null,
  custom: null,
};

const relayAccount = {
  id: "acc-relay",
  name: "某某中转",
  kind: "newApi" as const,
  enabled: true,
  baseUrl: "https://relay.example.com",
  apiKey: "",
  token: "tok",
  refreshToken: "",
  userId: 1,
  username: "",
  password: "",
  quotaPerUnit: null,
  custom: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
});

describe("App 看板", () => {
  it("无账号时显示空状态引导", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("还没有任何账号")).toBeTruthy();
    });
    expect(mockInvoke).toHaveBeenCalledWith("get_config");
  });

  it("刷新后渲染账号卡片与汇总（成功与失败并存）", async () => {
    const cfg = makeConfig([dsAccount, relayAccount]);
    const outcomes: RefreshOutcome[] = [
      {
        accountId: "acc-ds",
        ok: true,
        info: {
          balance: { amount: 110.5, currency: "CNY" },
          used: null,
          total: null,
          requests: 42,
          note: null,
          extras: [{ key: "赠送余额", value: "10.00" }],
          raw: { balance_infos: [] },
          fetchedAt: "2026-10-10T12:00:00+08:00",
          newToken: null,
          newRefreshToken: null,
        },
        error: null,
      },
      {
        accountId: "acc-relay",
        ok: false,
        info: null,
        error: "HTTP 401: 无效的访问令牌",
      },
    ];

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(cfg);
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "refresh_all") return Promise.resolve(outcomes);
      return Promise.resolve([]);
    });

    render(<App />);
    // 配置加载后出现两个卡片名称
    await waitFor(() => {
      expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
      expect(screen.getByText("某某中转")).toBeTruthy();
    });

    // 点「立即刷新」触发 refresh_all
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("refresh_all");
    });

    // 成功卡片：余额、附加行、请求数
    await waitFor(() => {
      expect(screen.getByText("110.50 CNY")).toBeTruthy();
    });
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("赠送余额")).toBeTruthy();
    // 失败卡片：错误信息展示
    expect(screen.getByText(/无效的访问令牌/)).toBeTruthy();
    // 汇总：2 个监控账号、1 正常 1 异常、CNY 合计
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("¥110.50")).toBeTruthy();
  });
});

describe("App 设置页", () => {
  it("切换到设置显示账号表格，并可返回看板", async () => {
    const cfg = makeConfig([relayAccount]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(cfg);
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("某某中转")).toBeTruthy();
    });

    // 进入设置
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    // 表格里能看到账号行与认证方式
    expect(screen.getByText("new-api 系中转")).toBeTruthy();
    expect(screen.getByText("Token")).toBeTruthy();

    // 返回看板
    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    await waitFor(() => {
      expect(screen.queryByText("账号管理")).toBeNull();
    });
  });

  it("编辑账号进入表单并显示类型对应的认证字段", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([relayAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("某某中转")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // 表单出现：newApi 类型应有访问令牌与用户 ID 字段（精确匹配标签 span，避开 hint 文案）
    await waitFor(() => {
      expect(screen.getByText("访问令牌 (access_token)")).toBeTruthy();
    });
    expect(screen.getByText("用户 ID (New-Api-User)")).toBeTruthy();
    // 名称输入框带初始值
    const nameInput = screen.getByDisplayValue("某某中转") as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    // Base URL 带初始值
    expect(screen.getByDisplayValue("https://relay.example.com")).toBeTruthy();
  });
});
