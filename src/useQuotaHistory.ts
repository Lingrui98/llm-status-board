import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { QuotaSample } from "./types";

const MAX_QUOTA_SAMPLES = 150_000;
const QUOTA_RETENTION_MS = 90 * 86_400_000;

export function mergeQuotaSamples(current: QuotaSample[], incremental: QuotaSample[], scope: string, maxSamples = MAX_QUOTA_SAMPLES): QuotaSample[] {
  const byTimestamp = new Map<string, QuotaSample>();
  for (const sample of [...current, ...incremental]) {
    if (sample.scope === scope) byTimestamp.set(sample.ts, sample);
  }
  const sorted = [...byTimestamp.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let latest = Number.NEGATIVE_INFINITY;
  for (const sample of sorted) {
    const time = Date.parse(sample.ts);
    if (Number.isFinite(time)) latest = Math.max(latest, time);
  }
  const cutoff = latest - QUOTA_RETENTION_MS;
  return sorted.filter(sample => {
    const time = Date.parse(sample.ts);
    return !Number.isFinite(time) || time >= cutoff;
  }).slice(-maxSamples);
}

export function useQuotaHistory(accountId: string, scope?: string | null, fetchedAt?: string) {
  const key = `${accountId}:${scope ?? ""}`;
  const [state, setState] = useState<{ key: string; samples: QuotaSample[]; error: string | null }>({ key, samples: [], error: null });
  const historyRef = useRef<{ key: string; samples: QuotaSample[] }>({ key, samples: [] });
  useEffect(() => {
    let disposed = false;
    const current = historyRef.current.key === key ? historyRef.current.samples : [];
    historyRef.current = { key, samples: current };
    if (!scope) return () => { disposed = true; };
    const since = current[current.length - 1]?.ts;
    void api.getQuotaHistory(accountId, scope, since).then(samples => {
      if (disposed) return;
      const merged = mergeQuotaSamples(current, Array.isArray(samples) ? samples : [], scope);
      historyRef.current = { key, samples: merged };
      setState({ key, samples: merged, error: null });
    }).catch(error => {
      if (!disposed) setState({ key, samples: historyRef.current.key === key ? historyRef.current.samples : [], error: String(error) });
    });
    return () => { disposed = true; };
  }, [accountId, scope, fetchedAt, key]);
  return state.key === key && scope ? state : { key, samples: [], error: null };
}
