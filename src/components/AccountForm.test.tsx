import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import AccountForm from "./AccountForm";
import * as api from "../api";
import type { AccountConfig, AccountInfo } from "../types";

vi.mock("../api", () => ({ testAccount: vi.fn(), pickCodexAuthFile: vi.fn(),
  startChatgptLogin: vi.fn(), openChatgptLogin: vi.fn(), chatgptLoginStatus: vi.fn(),
  cancelChatgptLogin: vi.fn(), discardChatgptAuth: vi.fn(),
  startModelServerLogin: vi.fn(), openModelServerLogin: vi.fn(),
  modelserverLoginStatus: vi.fn(), cancelModelServerLogin: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.cancelModelServerLogin).mockResolvedValue(undefined);
});

function renderForm() {
  const initial: AccountConfig = {
    id: "aihubmix-account",
    name: "AiHubMix 账号",
    kind: "newApi",
    enabled: true,
    baseUrl: "https://old-relay.example",
    apiKey: "old-key",
    token: "old-token",
    userId: 123,
    username: "",
    password: "",
  };
  const onSubmit = vi.fn();
  render(<AccountForm initial={initial} onSubmit={onSubmit} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("类型"), { target: { value: "aiHubMix" } });
  return { onSubmit };
}

describe("AiHubMix account setup", () => {
  it("selects the billing host and API-key authentication without inherited relay credentials", () => {
    const { onSubmit } = renderForm();
    expect((screen.getByLabelText(/^站点地址/) as HTMLInputElement).value).toBe("https://aihubmix.com");
    const key = screen.getByLabelText(/^API Key/) as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(screen.queryByLabelText(/访问令牌/)).toBeNull();
    expect(screen.queryByLabelText(/用户 ID/)).toBeNull();
    fireEvent.change(key, { target: { value: "test-aihubmix-key" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "aiHubMix", baseUrl: "https://aihubmix.com", apiKey: "test-aihubmix-key", token: "", userId: null,
    }));
  });

  it("tests the selected account and displays balance and cumulative usage in USD", async () => {
    vi.mocked(api.testAccount).mockResolvedValue({
      balance: { amount: 150.520778, currency: "USD" },
      used: { amount: 29370.458762, currency: "USD" },
      total: { amount: 29520.97954, currency: "USD" },
      extras: [], fetchedAt: "2026-10-19T00:00:00Z",
    });
    renderForm();
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "test-aihubmix-key" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("余额 150.52 USD · 已用 29,370.46 USD")).toBeTruthy();
    expect(api.testAccount).toHaveBeenCalledWith(expect.objectContaining({
      kind: "aiHubMix", baseUrl: "https://aihubmix.com", apiKey: "test-aihubmix-key",
    }));
  });

  it("explains API-key setup, cents conversion, and the absence of historical usage", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "怎么获取凭证？" }));
    expect(screen.getByText(/AiHubMix 的 API Key，无需访问令牌或用户 ID/)).toBeTruthy();
    expect(screen.getByText(/接口用量单位为美分，应用自动换算为美元/)).toBeTruthy();
    expect(screen.getByText(/计费接口不提供按日、按模型或 Token 明细/)).toBeTruthy();
  });

  it("shows billing errors when testing the connection fails", async () => {
    vi.mocked(api.testAccount).mockRejectedValue("AiHubMix 查询用量失败: billing request rejected");
    renderForm();
    fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "test-aihubmix-key" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/AiHubMix 查询用量失败: billing request rejected/)).toBeTruthy();
    expect(screen.queryByText(/连接成功/)).toBeNull();
  });
});

describe("Codex subscription account setup", () => {
  function setup() {
    const result = renderForm();
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "openAiSubscription" } });
    return result;
  }

  it("uses ChatGPT credentials and a separate provider from API billing", () => {
    const { onSubmit } = setup();
    const base = screen.getByLabelText(/^站点地址/) as HTMLInputElement;
    expect(base.value).toBe("https://chatgpt.com");
    expect(base.readOnly).toBe(true);
    expect(screen.queryByLabelText(/^API Key/)).toBeNull();
    const token = screen.getByLabelText("ChatGPT Access Token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "own-chatgpt-access-token" } });
    fireEvent.change(screen.getByLabelText(/^ChatGPT Account ID/), { target: { value: "workspace-account" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: "openAiSubscription", token: "own-chatgpt-access-token", chatgptAccountId: "workspace-account", apiKey: "", refreshToken: "" }));
  });

  it("stores only the chosen auth path and clears stale manual credentials", async () => {
    vi.mocked(api.pickCodexAuthFile).mockResolvedValue("/home/example/.codex/auth.json");
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("ChatGPT Access Token"), { target: { value: "stale-token" } });
    fireEvent.click(screen.getByRole("button", { name: "选择 auth.json" }));
    await screen.findByRole("button", { name: "改用令牌" });
    expect((screen.getByLabelText("Codex 登录文件路径") as HTMLInputElement).value).toBe("/home/example/.codex/auth.json");
    expect(screen.queryByLabelText("ChatGPT Access Token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ codexAuthPath: "/home/example/.codex/auth.json", token: "", chatgptAccountId: null }));
    fireEvent.click(screen.getByRole("button", { name: "改用令牌" }));
    expect((screen.getByLabelText("ChatGPT Access Token") as HTMLInputElement).value).toBe("");
  });

  it("reports quota percentages on test connection and explains session expiry", async () => {
    vi.mocked(api.testAccount).mockResolvedValue({ extras: [], fetchedAt: "2026-10-26T08:00:00Z", quotaWindows: [
      { window: "Codex · 5小时", usedPercent: 25 }, { window: "Codex · 每周", usedPercent: 60 },
    ] });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("Codex · 5小时 已用 25%，剩余 75% · Codex · 每周 已用 60%，剩余 40%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "怎么获取凭证？" }));
    expect(screen.getByText(/不自动刷新 OAuth 令牌/)).toBeTruthy();
    expect(screen.getByText(/API 平台的 sk- Key 无法查询订阅额度/)).toBeTruthy();
  });

  it("cancelling the file picker preserves the manual token", async () => {
    vi.mocked(api.pickCodexAuthFile).mockResolvedValue(null);
    setup();
    fireEvent.change(screen.getByLabelText("ChatGPT Access Token"), { target: { value: "keep-token" } });
    fireEvent.click(screen.getByRole("button", { name: "选择 auth.json" }));
    await Promise.resolve();
    expect((screen.getByLabelText("ChatGPT Access Token") as HTMLInputElement).value).toBe("keep-token");
  });

  it("saves a browser login reference while clearing stale tokens and file credentials", async () => {
    vi.mocked(api.startChatgptLogin).mockResolvedValue({ attemptId: "flow", authUrl: "https://auth.openai.com/oauth/authorize" });
    vi.mocked(api.openChatgptLogin).mockResolvedValue(undefined);
    vi.mocked(api.chatgptLoginStatus).mockResolvedValue({ status: "complete", authId: "managed-session", accountId: "workspace" });
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText("ChatGPT Access Token"), { target: { value: "stale-token" } });
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    await screen.findByText(/ChatGPT 已连接/);
    expect(screen.queryByLabelText("ChatGPT Access Token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ chatgptAuthId: "managed-session", chatgptAccountId: "workspace", token: "", refreshToken: "", codexAuthPath: null }));
  });
});

describe("ModelServer browser login account setup", () => {
  const flow = { attemptId: "modelserver-flow", authUrl: "https://code.cs.ac.cn/" };
  function setup() {
    const result = renderForm();
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "modelServer" } });
    return result;
  }

  it("fills the rotated refresh token and clears the stale access token", async () => {
    vi.mocked(api.startModelServerLogin).mockResolvedValue(flow);
    vi.mocked(api.modelserverLoginStatus).mockResolvedValue({ status: "complete", refreshToken: "browser-refresh" });
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText(/^refresh_token/), { target: { value: "old-refresh" } });
    fireEvent.change(screen.getByLabelText(/^access_token \(可选\)/), { target: { value: "old-access" } });
    fireEvent.click(screen.getByRole("button", { name: "重新网页登录" }));
    await screen.findByText(/已填写 refresh_token/);
    expect((screen.getByLabelText(/^refresh_token/) as HTMLInputElement).value).toBe("browser-refresh");
    expect((screen.getByLabelText(/^access_token \(可选\)/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "modelServer", baseUrl: "https://codeapi.cs.ac.cn", refreshToken: "browser-refresh", token: "",
    }));
  });

  it("preserves existing credentials when the native login fails", async () => {
    vi.mocked(api.startModelServerLogin).mockResolvedValue(flow);
    vi.mocked(api.modelserverLoginStatus).mockResolvedValue({ status: "failed", message: "登录窗口已关闭" });
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText(/^refresh_token/), { target: { value: "keep-refresh" } });
    fireEvent.change(screen.getByLabelText(/^access_token \(可选\)/), { target: { value: "keep-access" } });
    fireEvent.click(screen.getByRole("button", { name: "重新网页登录" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "keep-refresh", token: "keep-access" }));
  });

  it("disables site changes, testing, and submission while login is pending", async () => {
    vi.mocked(api.startModelServerLogin).mockResolvedValue(flow);
    vi.mocked(api.modelserverLoginStatus).mockReturnValue(new Promise(() => {}));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    await screen.findByLabelText("ModelServer 面板地址");
    expect((screen.getByLabelText(/^站点地址/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "测试连接" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "确定" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("serializes token tests with browser login and submission", async () => {
    let resolve!: (value: AccountInfo) => void;
    const response = new Promise<AccountInfo>((r) => { resolve = r; });
    vi.mocked(api.testAccount).mockReturnValue(response);
    const { onSubmit } = setup();
    fireEvent.change(screen.getByLabelText(/^refresh_token/), { target: { value: "consumed-refresh" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect((screen.getByRole("button", { name: "确定" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "重新网页登录" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^refresh_token/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("类型") as HTMLSelectElement).disabled).toBe(true);
    resolve({ extras: [], fetchedAt: "2026-10-28T00:00:00Z", note: "连接成功",
      newRefreshToken: "rotated-refresh", newToken: "rotated-access" });
    await screen.findByText("连接成功");
    expect((screen.getByRole("button", { name: "确定" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "重新网页登录" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText(/^refresh_token/) as HTMLInputElement).value).toBe("rotated-refresh");
    expect((screen.getByLabelText(/^access_token \(可选\)/) as HTMLInputElement).value).toBe("rotated-access");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      refreshToken: "rotated-refresh", token: "rotated-access",
    }));
  });
});
