import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import AccountForm from "./AccountForm";
import * as api from "../api";
import type { AccountConfig } from "../types";

vi.mock("../api", () => ({ testAccount: vi.fn() }));

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

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
