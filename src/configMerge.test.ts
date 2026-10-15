import { describe, expect, it } from "vitest";
import { mergeRotatedTokens, moveAccount } from "./configMerge";
import type { AccountConfig, AppConfig } from "./types";

function makeAccount(id: string, patch: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id,
    name: id,
    kind: "newApi",
    enabled: true,
    baseUrl: "https://example.com",
    apiKey: "",
    token: "",
    refreshToken: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
    ...patch,
  };
}

function makeConfig(accounts: AccountConfig[]): AppConfig {
  return { version: 1, settings: { autoRefreshSec: 0, refreshOnStart: false, proxy: null }, accounts };
}

describe("mergeRotatedTokens（token 轮换合并）", () => {
  it("用户没改 token 且磁盘已轮换 → 采用磁盘最新值", () => {
    const orig = makeConfig([makeAccount("a", { token: "old" })]);
    const disk = makeConfig([makeAccount("a", { token: "rotated" })]);
    // 用户只改了名字，token 与 orig 一致
    const next = makeConfig([makeAccount("a", { name: "改名了", token: "old" })]);
    const merged = mergeRotatedTokens(next, orig, disk);
    expect(merged.accounts[0].token).toBe("rotated");
    expect(merged.accounts[0].name).toBe("改名了"); // 其他字段以用户输入为准
  });

  it("用户自己改了 token → 保留用户值，不被磁盘覆盖", () => {
    const orig = makeConfig([makeAccount("a", { token: "old" })]);
    const disk = makeConfig([makeAccount("a", { token: "rotated" })]);
    const next = makeConfig([makeAccount("a", { token: "user-new" })]);
    expect(mergeRotatedTokens(next, orig, disk).accounts[0].token).toBe("user-new");
  });

  it("磁盘 token 与 orig 相同（未轮换）→ 保持用户值", () => {
    const orig = makeConfig([makeAccount("a", { token: "same" })]);
    const disk = makeConfig([makeAccount("a", { token: "same" })]);
    const next = makeConfig([makeAccount("a", { token: "same" })]);
    expect(mergeRotatedTokens(next, orig, disk).accounts[0].token).toBe("same");
  });

  it("refreshToken：空串归一化比较，磁盘轮换后被采纳", () => {
    const orig = makeConfig([makeAccount("a", { refreshToken: undefined })]);
    const disk = makeConfig([makeAccount("a", { refreshToken: "rt-new" })]);
    // 用户端该字段为 ""（与 undefined 视同未改）
    const next = makeConfig([makeAccount("a", { refreshToken: "" })]);
    expect(mergeRotatedTokens(next, orig, disk).accounts[0].refreshToken).toBe("rt-new");
  });

  it("新增账号（磁盘上还没有）与已删账号（基准里没有）原样保留", () => {
    const orig = makeConfig([makeAccount("a", { token: "t1" })]);
    const disk = makeConfig([makeAccount("a", { token: "t1-rotated" })]);
    const next = makeConfig([makeAccount("a", { token: "t1" }), makeAccount("b", { token: "tb" })]);
    const merged = mergeRotatedTokens(next, orig, disk);
    expect(merged.accounts.map((x) => x.id)).toEqual(["a", "b"]);
    expect(merged.accounts[0].token).toBe("t1-rotated");
    expect(merged.accounts[1].token).toBe("tb"); // 无磁盘对应项，不动
  });

  it("orig 为 null（无基准快照）→ 全部按用户输入", () => {
    const disk = makeConfig([makeAccount("a", { token: "rotated" })]);
    const next = makeConfig([makeAccount("a", { token: "user" })]);
    expect(mergeRotatedTokens(next, null, disk).accounts[0].token).toBe("user");
  });

  it("settings 与账号顺序以用户输入为准", () => {
    const orig = makeConfig([makeAccount("a"), makeAccount("b")]);
    const disk = makeConfig([makeAccount("a"), makeAccount("b")]);
    const next: AppConfig = {
      ...makeConfig([makeAccount("b"), makeAccount("a")]), // 用户调了顺序
      settings: { autoRefreshSec: 120, refreshOnStart: true, proxy: "http://127.0.0.1:7890" },
    };
    const merged = mergeRotatedTokens(next, orig, disk);
    expect(merged.accounts.map((x) => x.id)).toEqual(["b", "a"]);
    expect(merged.settings.autoRefreshSec).toBe(120);
    expect(merged.settings.proxy).toBe("http://127.0.0.1:7890");
  });
});

describe("moveAccount（账号排序）", () => {
  const list = [makeAccount("a"), makeAccount("b"), makeAccount("c")];

  it("上移：与前一项交换", () => {
    expect(moveAccount(list, "b", -1).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("下移：与后一项交换", () => {
    expect(moveAccount(list, "b", 1).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("首项上移 / 末项下移：原样返回（同一引用）", () => {
    expect(moveAccount(list, "a", -1)).toBe(list);
    expect(moveAccount(list, "c", 1)).toBe(list);
  });

  it("id 不存在：原样返回", () => {
    expect(moveAccount(list, "nope", 1)).toBe(list);
  });

  it("不修改原数组", () => {
    const before = list.map((x) => x.id);
    moveAccount(list, "a", 1);
    expect(list.map((x) => x.id)).toEqual(before);
  });
});
