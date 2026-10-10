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
// mock dialog 插件（jsdom 无原生对话框；macOS 上 window.confirm 也不可用）
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
const mockOpen = vi.mocked(open);
const mockConfirm = vi.mocked(confirm);

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
  it("启动时加载上次刷新结果（无需点刷新即可见旧数据）", async () => {
    const lastOutcome: RefreshOutcome = {
      accountId: "acc-ds",
      ok: true,
      info: {
        balance: { amount: 88.88, currency: "CNY" },
        used: null,
        total: null,
        requests: null,
        note: null,
        extras: [],
        raw: null,
        fetchedAt: "2026-10-09T08:30:00+08:00",
        newToken: null,
        newRefreshToken: null,
      },
      error: null,
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([dsAccount]));
      if (cmd === "get_last_results") return Promise.resolve([lastOutcome]);
      return Promise.resolve([]);
    });

    render(<App />);
    // 无需任何交互，上次余额直接出现
    await waitFor(() => {
      expect(screen.getByText("88.88 CNY")).toBeTruthy();
    });
    // 卡片时间戳显示为上次会话的旧时间（08:30）
    expect(screen.getByText(/08:30/)).toBeTruthy();
    // refresh_all 不应被自动调用（refreshOnStart=false）
    expect(mockInvoke).not.toHaveBeenCalledWith("refresh_all");
  });

  it("启动时跳过已删除账号的旧结果", async () => {
    const staleOutcome: RefreshOutcome = {
      accountId: "acc-deleted",
      ok: true,
      info: {
        balance: { amount: 1.23, currency: "USD" },
        used: null,
        total: null,
        requests: null,
        note: null,
        extras: [],
        raw: null,
        fetchedAt: "2026-10-01T00:00:00+08:00",
        newToken: null,
        newRefreshToken: null,
      },
      error: null,
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([dsAccount]));
      if (cmd === "get_last_results") return Promise.resolve([staleOutcome]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
    });
    // 已删除账号（acc-deleted）的旧数据不应出现
    await waitFor(() => {
      expect(screen.queryByText("1.23 USD")).toBeNull();
    });
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

describe("App 配置导入/导出", () => {
  const baseAccount = {
    id: "acc-1",
    name: "本机账号",
    kind: "deepSeek" as const,
    enabled: true,
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-1",
    token: "",
    refreshToken: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
  };

  const importedConfig: AppConfig = {
    version: 1,
    settings: { autoRefreshSec: 600, refreshOnStart: true, proxy: null },
    accounts: [
      baseAccount,
      {
        ...baseAccount,
        id: "acc-2",
        name: "导入的新账号",
        kind: "sub2Api",
        baseUrl: "https://relay.example.com",
      },
    ],
  };

  it("导出：选路径后调用 export_config", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "export_config") return Promise.resolve(undefined);
      return Promise.resolve([]);
    });
    mockSave.mockResolvedValue("C:/Users/x/Desktop/lsb-config.json");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "导出配置" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("export_config", {
        path: "C:/Users/x/Desktop/lsb-config.json",
      });
    });
    // 成功提示包含路径
    await waitFor(() => {
      expect(screen.getByText(/已导出到/)).toBeTruthy();
    });
  });

  it("导入：确认后合并账号并刷新表单", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "import_config") return Promise.resolve(importedConfig);
      return Promise.resolve([]);
    });
    mockConfirm.mockResolvedValue(true);
    mockOpen.mockResolvedValue("C:/Users/x/Desktop/lsb-config.json");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });

    // 导入前只有 1 个账号
    expect(screen.queryByText("导入的新账号")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "导入配置" }));
    // 合并后的新账号出现在表格里
    await waitFor(() => {
      expect(screen.getByText("导入的新账号")).toBeTruthy();
    });
    expect(mockInvoke).toHaveBeenCalledWith("import_config", {
      path: "C:/Users/x/Desktop/lsb-config.json",
    });
    // 成功提示显示账号数
    expect(screen.getByText("已导入 2 个账号")).toBeTruthy();
  });

  it("导入取消确认后不做任何事", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });
    mockConfirm.mockResolvedValue(false);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "导入配置" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("import_config", expect.anything());
  });
});
