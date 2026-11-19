import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOpenAiUsageFilters, getOpenAiUsageReport } from "../api";
import type { OpenAiUsageReport } from "../types";
import OpenAiUsagePanel from "./OpenAiUsagePanel";

vi.mock("../api", () => ({ getOpenAiUsageFilters: vi.fn(), getOpenAiUsageReport: vi.fn() }));
vi.mock("./charts/OpenAiTrendChart", () => ({
  default: ({ metric, days }: { metric: string; days: OpenAiUsageReport["days"] }) =>
    <div data-testid={metric}>{days[0]?.cost}</div>,
}));

const usage = (cost: number, patch: Partial<OpenAiUsageReport> = {}): OpenAiUsageReport => ({
  days: [{ date: "2026-11-18", cost, monthToDate: cost }],
  models: [], currency: "USD", costsError: null, usageError: null, ...patch,
});

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("OpenAI API organization details", () => {
  it("filters both datasets by project and Key, and discards older results arriving after a filter change", async () => {
    const load = vi.mocked(getOpenAiUsageReport);
    let resolveOrganization!: (report: OpenAiUsageReport) => void;
    load.mockReturnValueOnce(new Promise((resolve) => { resolveOrganization = resolve; }));
    load.mockImplementation(async (_account, _start, _end, _project, key) => usage(key ? 2 : 4));
    vi.mocked(getOpenAiUsageFilters).mockImplementation(async (_account, project) =>
      project ? [{ id: "key_1", name: "App Key" }] : [{ id: "proj_1", name: "Production" }]);
    const now = Date.parse("2026-11-18T03:45:00Z");
    render(<OpenAiUsagePanel accountId="org" now={now} />);
    await screen.findByRole("option", { name: "Production" });
    expect(load).toHaveBeenCalledWith("org", "2026-11-01", "2026-11-18", undefined, undefined);
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "proj_1" } });
    await screen.findByRole("option", { name: "App Key" });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "key_1" } });
    await waitFor(() => expect(screen.getByTestId("cost").textContent).toBe("2"));
    await act(async () => resolveOrganization(usage(99)));
    expect(screen.getByTestId("cost").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "7天" }));
    expect(load).toHaveBeenLastCalledWith("org", "2026-11-12", "2026-11-18", "proj_1", "key_1");
  });

  it("shows spending when the Admin Key cannot query tokens", async () => {
    vi.mocked(getOpenAiUsageFilters).mockResolvedValue([]);
    vi.mocked(getOpenAiUsageReport).mockResolvedValue(usage(12, { usageError: "HTTP 403" }));
    render(<OpenAiUsagePanel accountId="org" now={Date.parse("2026-11-18T23:00:00Z")} />);
    expect((await screen.findByTestId("cost")).textContent).toBe("12");
    expect(screen.getByRole("alert").textContent).toContain("HTTP 403");
    expect(screen.queryByTestId("tokens")).toBeNull();
  });
});
