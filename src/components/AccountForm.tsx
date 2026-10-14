import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountConfig, CustomQuery, ProviderKind } from "../types";
import { PROVIDER_KINDS, DEFAULT_BASE_URLS } from "../types";
import * as api from "../api";
import { formatMoney, formatNumber } from "../format";

interface Props {
  initial: AccountConfig;
  onSubmit: (account: AccountConfig) => void;
  onCancel: () => void;
}

interface AuthField {
  field: "apiKey" | "token" | "username" | "password" | "userId" | "refreshToken";
  label: string;
  placeholder: string;
  type?: "text" | "password" | "number";
  hint?: string;
}

const AUTH_FIELDS: Record<ProviderKind, AuthField[]> = {  oneApi: [
    { field: "token", label: "访问令牌 (access_token)", placeholder: "浏览器 F12 → 网络/存储 里找 token", type: "password", hint: "one-api 系用站点下发的 token（不是 sk- 开头的 API Key）" },
  ],
  newApi: [
    { field: "token", label: "访问令牌 (access_token)", placeholder: "浏览器 F12 → localStorage/网络 里的 token", type: "password", hint: "new-api 系用站点下发的系统访问令牌" },
    { field: "userId", label: "用户 ID (New-Api-User)", placeholder: "例如 1234", type: "number", hint: "new-api 接口要求的请求头 New-Api-User，填你的用户数字 ID" },
  ],
  sub2Api: [
    { field: "apiKey", label: "API Key（推荐）", placeholder: "sk-...", type: "password", hint: "只用 key 即可查询余额与用量（走 /v1/usage）" },
    { field: "token", label: "访问令牌（可选）", placeholder: "有 token 就不用填账号密码", type: "password" },
    { field: "username", label: "用户名 / 邮箱", placeholder: "", type: "text" },
    { field: "password", label: "密码", placeholder: "", type: "password" },
  ],
  modelServer: [
    { field: "refreshToken", label: "refresh_token", placeholder: "浏览器 localStorage 里导出", type: "password", hint: "在面板网页 F12 → Application → Local Storage → refresh_token 复制" },
    { field: "token", label: "access_token (可选)", placeholder: "短期有效，一般留空", type: "password" },
  ],
  deepSeek: [
    { field: "apiKey", label: "API Key", placeholder: "sk-...", type: "password" },
  ],
  openAi: [
    { field: "apiKey", label: "API Key（需要管理员权限）", placeholder: "sk-admin-... 或 sk-svcacct-...", type: "password", hint: "查询组织用量需要 admin 权限的 key" },
  ],
  siliconFlow: [
    { field: "apiKey", label: "API Key", placeholder: "sk-...", type: "password" },
  ],
  moonshot: [
    {
      field: "apiKey",
      label: "API Key",
      placeholder: "sk-... 或 sk-kimi-...",
      type: "password",
      hint: "按 Key 前缀自动分流：sk-kimi-（Kimi for Coding 订阅，查订阅额度/5h/7d/月度窗口）→ 其他 sk-（开放平台按量计费，查余额）。订阅 Key 在 www.kimi.com/code/console 生成",
    },
  ],
  zhipu: [
    { field: "apiKey", label: "API Key", placeholder: "....xxxxxxxx.xxxxxxxx", type: "password" },
  ],
  dashScope: [
    { field: "apiKey", label: "API Key", placeholder: "sk-...", type: "password" },
  ],
  custom: [
    { field: "apiKey", label: "API Key", placeholder: "sk-...（供 {key} 占位符引用）", type: "password" },
  ],
};

export default function AccountForm({ initial, onSubmit, onCancel }: Props) {
  const [acc, setAcc] = useState<AccountConfig>({ ...initial });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // 「测试连接」按钮本身的瞬时反馈（成功绿/失败红描边，2.4s 后消退）
  const [testFlash, setTestFlash] = useState<"ok" | "fail" | null>(null);
  const flashTimer = useRef<number | null>(null);

  const authFields = useMemo(() => AUTH_FIELDS[acc.kind] ?? [], [acc.kind]);
  // 类型下拉分组：从 PROVIDER_KINDS 派生，保证组名/顺序与表格徽章等口径一致
  const kindGroups = useMemo(() => [...new Set(PROVIDER_KINDS.map((k) => k.group))], []);

  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const set = (patch: Partial<AccountConfig>) => setAcc((a) => ({ ...a, ...patch }));

  const changeKind = (kind: ProviderKind) => {
    setAcc((a) => ({
      ...a,
      kind,
      baseUrl: DEFAULT_BASE_URLS[kind],
      apiKey: "",
      token: "",
      userId: null,
      username: "",
      password: "",
      custom: kind === "custom" ? defaultCustom() : null,
    }));
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestFlash(null);
    let ok = false;
    try {
      const info = await api.testAccount(acc);
      // 一次性 refresh token 轮换：测试成功后把返回的新 token 合并进表单，
      // 保证随后保存到配置里的是新鲜 token（旧的可能已被本次测试消耗）
      const patch: Partial<AccountConfig> = {};
      if (info.newToken) patch.token = info.newToken;
      if (info.newRefreshToken) patch.refreshToken = info.newRefreshToken;
      if (Object.keys(patch).length > 0) {
        setAcc((a) => ({ ...a, ...patch }));
      }
      const parts: string[] = [];
      if (info.balance) parts.push(`余额 ${formatMoney(info.balance)}`);
      if (info.used) parts.push(`已用 ${formatMoney(info.used)}`);
      if (info.requests !== null && info.requests !== undefined) parts.push(`请求 ${formatNumber(info.requests)}`);
      ok = true;
      setTestResult({ ok: true, msg: parts.join(" · ") || info.note || "连接成功" });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
      setTestFlash(ok ? "ok" : "fail");
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setTestFlash(null), 2400);
    }
  };

  const valid = acc.name.trim().length > 0 && acc.baseUrl.trim().length > 0;

  return (
    <div className="account-form">
      <div className="form-grid">
        <label className="form-field">
          <span>名称 *</span>
          <input
            value={acc.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="例如：某某中转 / DeepSeek 官方"
          />
        </label>

        <label className="form-field">
          <span>类型</span>
          <select value={acc.kind} onChange={(e) => changeKind(e.target.value as ProviderKind)}>
            {kindGroups.map((group) => (
              <optgroup key={group} label={group}>
                {PROVIDER_KINDS.filter((k) => k.group === group).map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="form-field wide">
          <span>站点地址 (Base URL)</span>
          <input value={acc.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
          {acc.kind === "modelServer" && (
            <em className="field-hint">
              填 API 后端地址 <code>https://codeapi.cs.ac.cn</code>（不是网页面板的
              code.cs.ac.cn；填错了会自动纠正）。凭证取法：网页面板登录后 F12 →
              Application → Local Storage → 复制 <code>refresh_token</code> 的值填到下方
            </em>
          )}
        </label>

        {(acc.kind === "oneApi" || acc.kind === "newApi") && (
          <label className="form-field wide">
            <span>API Key（可选，与令牌二选一）</span>
            <input
              type="password"
              value={acc.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder="sk-...（走 /v1/dashboard/billing 接口）"
            />
            <em className="field-hint">与访问令牌二选一；填了 Key 就改走 /v1/dashboard/billing 计费接口查询</em>
          </label>
        )}

        {authFields.map((f) => (
          <label className="form-field" key={f.field}>
            <span>{f.label}</span>
            <input
              type={f.type ?? "text"}
              value={(acc as unknown as Record<string, unknown>)[f.field] as string | number | undefined ?? ""}
              onChange={(e) =>
                set({ [f.field]: f.type === "number" ? Number(e.target.value) || null : e.target.value } as Partial<AccountConfig>)
              }
              placeholder={f.placeholder}
            />
            {f.hint && <em className="field-hint">{f.hint}</em>}
          </label>
        ))}

        {(acc.kind === "oneApi" || acc.kind === "newApi") && (
          <label className="form-field">
            <span>额度换算系数（可选）</span>
            <input
              type="number"
              value={acc.quotaPerUnit ?? ""}
              onChange={(e) => set({ quotaPerUnit: Number(e.target.value) || null })}
              placeholder="默认 500000（1 美元对应的点数）"
            />
            <em className="field-hint">站点点数 → 美元的换算比例，留空按 500000 点 = 1 美元计</em>
          </label>
        )}

        {acc.kind === "custom" && (
          <CustomEditor
            value={acc.custom ?? defaultCustom()}
            onChange={(c) => set({ custom: c })}
          />
        )}
      </div>

      {testResult && (
        <div className={testResult.ok ? "test-result ok" : "test-result fail"}>
          <pre>{testResult.msg}</pre>
        </div>
      )}

      <div className="form-actions">
        <button
          className={`btn ghost test-btn${testFlash ? ` ${testFlash}` : ""}`}
          onClick={handleTest}
          disabled={testing || !valid}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        <div className="spacer" />
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" onClick={() => onSubmit(acc)} disabled={!valid}>
          确定
        </button>
      </div>
    </div>
  );
}

function defaultCustom(): CustomQuery {
  return {
    method: "GET",
    url: "https://your-relay-site.com/api/user/self",
    headers: [{ key: "Authorization", value: "Bearer {key}" }],
    body: null,
    balancePath: "data.quota",
    usedPath: "data.used_quota",
    totalPath: null,
    currencyPath: null,
    currency: "POINTS",
    scale: 0.000002,
    extraPaths: [],
  };
}

function CustomEditor({ value, onChange }: { value: CustomQuery; onChange: (c: CustomQuery) => void }) {
  const set = (patch: Partial<CustomQuery>) => onChange({ ...value, ...patch });
  return (
    <div className="custom-editor">
      <h4>自定义 HTTP 查询</h4>
      <p className="muted small">
        发一个 HTTP 请求，用点路径（如 <code>data.balance</code> 或 <code>balance_infos[0].total_balance</code>）从 JSON 响应里提取数值。
        URL / Header / Body 支持 <code>{"{key}"}</code> 占位符（会被替换成 API Key）。
      </p>
      <div className="form-grid">
        <label className="form-field">
          <span>方法</span>
          <select value={value.method} onChange={(e) => set({ method: e.target.value })}>
            <option>GET</option>
            <option>POST</option>
          </select>
        </label>
        <label className="form-field wide">
          <span>URL</span>
          <input value={value.url} onChange={(e) => set({ url: e.target.value })} />
        </label>
        <label className="form-field">
          <span>数值缩放系数（可选）</span>
          <input
            type="number"
            step="any"
            value={value.scale ?? ""}
            onChange={(e) => set({ scale: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="如 0.000002（点数→美元）"
          />
        </label>
        <label className="form-field">
          <span>货币代码（可选）</span>
          <input value={value.currency ?? ""} onChange={(e) => set({ currency: e.target.value || null })} placeholder="USD / CNY / POINTS" />
        </label>
        <label className="form-field">
          <span>余额字段路径（可选）</span>
          <input value={value.balancePath ?? ""} onChange={(e) => set({ balancePath: e.target.value || null })} />
        </label>
        <label className="form-field">
          <span>已用字段路径（可选）</span>
          <input value={value.usedPath ?? ""} onChange={(e) => set({ usedPath: e.target.value || null })} />
        </label>
        <label className="form-field">
          <span>总额度字段路径（可选）</span>
          <input value={value.totalPath ?? ""} onChange={(e) => set({ totalPath: e.target.value || null })} />
        </label>
        <label className="form-field">
          <span>货币字段路径（可选，优先于货币代码）</span>
          <input value={value.currencyPath ?? ""} onChange={(e) => set({ currencyPath: e.target.value || null })} />
        </label>
        <label className="form-field wide">
          <span>请求头（每行一个 Name: Value）</span>
          <textarea
            rows={3}
            value={value.headers.map((h) => `${h.key}: ${h.value}`).join("\n")}
            onChange={(e) =>
              set({
                headers: e.target.value
                  .split("\n")
                  .map((line) => {
                    const i = line.indexOf(":");
                    return i < 0 ? { key: line.trim(), value: "" } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
                  })
                  .filter((h) => h.key.length > 0),
              })
            }
            placeholder={"Authorization: Bearer {key}"}
          />
        </label>
        {value.method === "POST" && (
          <label className="form-field wide">
            <span>请求体（JSON，可选）</span>
            <textarea rows={3} value={value.body ?? ""} onChange={(e) => set({ body: e.target.value || null })} />
          </label>
        )}
        <label className="form-field wide">
          <span>附加展示字段（每行一个 名称=点路径）</span>
          <textarea
            rows={2}
            value={value.extraPaths.map((p) => `${p.key}=${p.value}`).join("\n")}
            onChange={(e) =>
              set({
                extraPaths: e.target.value
                  .split("\n")
                  .map((line) => {
                    const i = line.indexOf("=");
                    return i < 0 ? { key: line.trim(), value: "" } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
                  })
                  .filter((p) => p.key.length > 0),
              })
            }
            placeholder={"请求数=data.request_count"}
          />
        </label>
      </div>
      <p className="muted small">
        API Key 填在上方「API Key」框（类型选自定义时也会显示一个 Key 输入框）——占位符 <code>{"{key}"}</code> 引用它。
      </p>
    </div>
  );
}
