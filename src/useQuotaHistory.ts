import { useEffect, useState } from "react";
import * as api from "./api";
import type { QuotaSample } from "./types";

export function useQuotaHistory(accountId: string, scope?: string | null, fetchedAt?: string) {
  const key = `${accountId}:${scope ?? ""}`;
  const [state, setState] = useState<{ key: string; samples: QuotaSample[]; error: string | null }>({ key, samples: [], error: null });
  useEffect(() => {
    let disposed = false;
    if (!scope) return;
    void api.getQuotaHistory(accountId, scope).then(samples => {
      if (!disposed) setState({ key, samples: Array.isArray(samples) ? samples.filter(s => s.scope === scope) : [], error: null });
    }).catch(error => {
      if (!disposed) setState(old => ({ key, samples: old.key === key ? old.samples : [], error: String(error) }));
    });
    return () => { disposed = true; };
  }, [accountId, scope, fetchedAt, key]);
  return state.key === key && scope ? state : { key, samples: [], error: null };
}
