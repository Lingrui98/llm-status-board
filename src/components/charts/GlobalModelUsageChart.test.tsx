import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountConfig, RefreshOutcome, UsagePoint } from "../../types";
import GlobalModelUsageChart from "./GlobalModelUsageChart";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  BarChart: ({ data }: { data: unknown }) => <div data-testid="model-chart" data-rows={JSON.stringify(data)} />,
  Bar: () => null,
  LabelList: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

afterEach(cleanup);

const account = (id: string, kind: AccountConfig["kind"]): AccountConfig => ({
  id, name: id, kind, enabled: true, baseUrl: "", apiKey: "", token: "", username: "", password: "",
});

const status = (accountId: string, modelUsage: UsagePoint[]): RefreshOutcome => ({
  accountId,
  ok: true,
  info: { extras: [], fetchedAt: "2026-11-18T00:00:00Z", modelUsage },
});

const rows = () => JSON.parse(screen.getByTestId("model-chart").getAttribute("data-rows")!);

it("ranks merged OpenAI and relay models by the chosen metric and keeps token-only models", () => {
  const accounts = [account("openai", "openAi"), account("relay", "sub2Api")];
  const statuses = {
    openai: status("openai", [{ model: "shared", requests: 7, tokens: 80 }]),
    relay: status("relay", [
      { model: "shared", requests: 5 },
      { model: "tokens-only", inputTokens: 700, outputTokens: 300 },
      { model: "requests-only", requests: 9 },
    ]),
  };
  render(<GlobalModelUsageChart accounts={accounts} statuses={statuses} />);
  expect(rows()).toMatchObject([
    { model: "shared", requests: 12, tokens: 80, partialTokens: true, accounts: 2 },
    { model: "requests-only", requests: 9, tokens: null },
  ]);

  fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));
  expect(rows()).toMatchObject([
    { model: "tokens-only", requests: null, tokens: 1000, accounts: 1 },
    { model: "shared", requests: 12, tokens: 80 },
  ]);
});
