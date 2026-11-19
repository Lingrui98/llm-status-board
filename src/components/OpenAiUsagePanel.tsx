import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { getOpenAiUsageFilters, getOpenAiUsageReport } from "../api";
import { formatNumber } from "../format";
import type { OpenAiFilterOption } from "../types";
import DrawerSection from "./DrawerSection";

const OpenAiTrendChart = lazy(() => import("./charts/OpenAiTrendChart"));
const DAY_MS = 86_400_000;
const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10);
const parseDay = (date: string) => Date.parse(`${date}T00:00:00Z`);
const ranges = [
  ["month", "本月"],
  ["7", "7天"],
  ["30", "30天"],
  ["90", "90天"],
  ["custom", "自定义"],
] as const;
type Range = (typeof ranges)[number][0];

function useOpenAiQuery<T>(request: () => Promise<T>, enabled = true) {
  const [result, setResult] = useState<{ request: typeof request; data?: T; error?: string }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    request().then(
      (data) => { if (active) setResult({ request, data }); },
      (error: unknown) => { if (active) setResult({ request, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { active = false; };
  }, [request, enabled]);
  // A different filter must never display the result of the previous request.
  const current = enabled && result?.request === request ? result : undefined;
  return { data: current?.data, error: current?.error, loading: enabled && !current };
}

function FilterSelect({ label, value, change, options, all, disabled }: {
  label: string;
  value: string;
  change: (id: string) => void;
  options?: OpenAiFilterOption[];
  all: string;
  disabled?: boolean;
}) {
  return <label className="form-field">
    <span>{label}</span>
    <select value={value} onChange={(e) => change(e.target.value)} disabled={disabled}>
      <option value="">{all}</option>
      {value && !options?.some((option) => option.id === value) && <option value={value}>{value}</option>}
      {options?.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>
  </label>;
}

export default function OpenAiUsagePanel({ accountId, fetchedAt, now }: { accountId: string; fetchedAt?: string; now: number }) {
  const today = dateKey(now);
  const [range, setRange] = useState<Range>("month");
  const [customStart, setCustomStart] = useState(() => `${today.slice(0, 7)}-01`);
  const [customEnd, setCustomEnd] = useState(today);
  const [projectId, setProjectId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [revision, setRevision] = useState(0);
  const start = range === "custom" ? customStart
    : range === "month" ? `${today.slice(0, 7)}-01`
      : dateKey(parseDay(today) - (Number(range) - 1) * DAY_MS);
  const end = range === "custom" ? customEnd : today;
  const earliest = dateKey(parseDay(today) - 366 * DAY_MS);
  const valid = start !== "" && end !== "" && start >= earliest && start <= end && end <= today
    && parseDay(end) - parseDay(start) < 90 * DAY_MS;

  const projectsRequest = useCallback(() => getOpenAiUsageFilters(accountId), [accountId, revision]);
  const keysRequest = useCallback(() => getOpenAiUsageFilters(accountId, projectId), [accountId, projectId, revision]);
  const reportRequest = useCallback(() => getOpenAiUsageReport(accountId, start, end, projectId || undefined, keyId || undefined),
    [accountId, start, end, projectId, keyId, fetchedAt, revision]);
  const projects = useOpenAiQuery(projectsRequest);
  const keys = useOpenAiQuery(keysRequest, projectId !== "");
  const report = useOpenAiQuery(reportRequest, valid);
  const data = report.data;

  return <div className="account-trends openai-usage">
    <div className="trend-controls">
      <div className="openai-usage-filters">
        <FilterSelect label="项目" value={projectId} change={(id) => { setProjectId(id); setKeyId(""); }}
          options={projects.data} all="整个组织" disabled={projects.loading || Boolean(projects.error)} />
        <FilterSelect label="API Key" value={keyId} change={setKeyId} options={keys.data}
          all={projectId ? "该项目的所有 Key" : "先选择项目"} disabled={!projectId || keys.loading || Boolean(keys.error)} />
      </div>
      {projects.error && <p className="trend-history-note" role="status">项目列表不可用：{projects.error}</p>}
      {keys.error && <p className="trend-history-note" role="status">Key 列表不可用：{keys.error}</p>}
      <div className="openai-usage-range">
        <div className="trend-range-buttons" role="group" aria-label="OpenAI 统计日期">
          {ranges.map(([id, label]) => <button key={id} type="button" aria-pressed={range === id} onClick={() => setRange(id)}>{label}</button>)}
        </div>
        <button className="link-btn" type="button" onClick={() => setRevision((value) => value + 1)}>刷新统计</button>
      </div>
      {range === "custom" && <div className="openai-usage-filters">
        <label className="form-field">开始日期<input type="date" value={customStart} min={earliest} max={today} onChange={(e) => setCustomStart(e.target.value)} /></label>
        <label className="form-field">结束日期<input type="date" value={customEnd} min={earliest} max={today} onChange={(e) => setCustomEnd(e.target.value)} /></label>
      </div>}
      <p className="trend-history-note">UTC · {start && end ? `${start} 至 ${end}` : "请选择日期"} · 今日数据可能延迟</p>
      {!valid && <p className="trend-range-error" role="status">请选择近一年内、最长 90 天且不含未来日期的区间。</p>}
    </div>
    {report.loading && <p className="trend-history-note" role="status">正在查询 OpenAI 费用和用量…</p>}
    {report.error && <p className="trend-range-error" role="alert">{report.error}</p>}
    {data && <>
      {data.costsError && <p className="trend-range-error" role="alert">费用查询失败：{data.costsError}</p>}
      {data.usageError && <p className="trend-range-error" role="alert">用量查询失败：{data.usageError}</p>}
      {!data.costsError && <Suspense fallback={<p className="trend-history-note">正在加载图表…</p>}>
        <OpenAiTrendChart days={data.days} metric="cost" currency={data.currency} />
        <OpenAiTrendChart days={data.days} metric="monthToDate" currency={data.currency} />
      </Suspense>}
      {!data.usageError && <>
        <p className="trend-history-note">下方 Token 与请求数统计 Responses 和 Chat Completions。</p>
        <Suspense fallback={<p className="trend-history-note">正在加载图表…</p>}>
          <OpenAiTrendChart days={data.days} metric="tokens" currency={null} />
          <OpenAiTrendChart days={data.days} metric="requests" currency={null} />
        </Suspense>
        <DrawerSection key={String(data.models.length > 0)} title="模型用量 TOP 8" hasData={data.models.length > 0} emptyNote="所选范围暂无模型用量">
          <div className="openai-model-table">
            <table>
              <thead><tr><th>模型</th><th>输入 Token</th><th>输出 Token</th><th>请求数</th></tr></thead>
              <tbody>{data.models.map((model) => <tr key={model.name}>
                <th scope="row">{model.name}</th>
                <td>{formatNumber(model.inputTokens)}</td><td>{formatNumber(model.outputTokens)}</td><td>{formatNumber(model.requests)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </DrawerSection>
      </>}
    </>}
  </div>;
}
