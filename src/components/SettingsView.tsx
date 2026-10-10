import { useEffect, useState } from "react";
import type { AccountConfig, AppConfig, CustomQuery, KeyValue, ProviderKind } from "../types";
import { PROVIDER_KINDS, DEFAULT_BASE_URLS, newAccountId } from "../types";
import AccountForm from "./AccountForm";
import * as api from "../api";

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function SettingsView({ config, onSave, onRefresh }: Props) {
  const [accounts, setAccounts] = useState<AccountConfig[]>(config.accounts);
  const [autoRefreshSec, setAutoRefreshSec] = useState(config.settings.autoRefreshSec);
  const [refreshOnStart, setRefreshOnStart] = useState(config.settings.refreshOnStart);
  const [proxy, setProxy] = useState(config.settings.proxy ?? "");
  const [editing, setEditing] = useState<AccountConfig | null>(null); // null=列表, {}=新增
  const [saving, setSaving] = useState(false);
  const [savedTip, setSavedTip] = useState("");
  const [cfgPath, setCfgPath] = useState<string>("");

  useEffect(() => {
    api.configPath().then(setCfgPath).catch(() => {});
  }, []);

  const showTip = (msg: string) => {
    setSavedTip(msg);
    window.setTimeout(() => setSavedTip(""), 2500);
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await onSave({
        ...config,
        accounts,
        settings: { autoRefreshSec, refreshOnStart, proxy: proxy.trim() || null },
      });
      showTip("已保存");
    } catch (e) {
      showTip(`保存失败: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const addAccount = () => {
    const kind: ProviderKind = "newApi";
    setEditing({
      id: newAccountId(),
      name: "",
      kind,
      enabled: true,
      baseUrl: DEFAULT_BASE_URLS[kind],
      apiKey: "",
      token: "",
      userId: null,
      username: "",
      password: "",
      quotaPerUnit: null,
      custom: null,
    });
  };

  const upsertAccount = (acc: AccountConfig) => {
    setAccounts((prev) => {
      const i = prev.findIndex((a) => a.id === acc.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = acc;
        return copy;
      }
      return [...prev, acc];
    });
    setEditing(null);
  };

  const removeAccount = (id: string) => {
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  };

  const toggleEnabled = (id: string) => {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  };

  const duplicateAccount = (acc: AccountConfig) => {
    setAccounts((prev) => [...prev, { ...acc, id: newAccountId(), name: acc.name + " 副本" }]);
  };

  if (editing) {
    return (
      <main className="main">
        <div className="settings-header">
          <h2>{accounts.some((a) => a.id === editing.id) ? "编辑账号" : "添加账号"}</h2>
          <button className="btn ghost" onClick={() => setEditing(null)}>
            取消
          </button>
        </div>
        <AccountForm initial={editing} onSubmit={upsertAccount} onCancel={() => setEditing(null)} />
      </main>
    );
  }

  return (
    <main className="main">
      <div className="settings-header">
        <h2>账号管理</h2>
        <div className="settings-actions">
          <button className="btn ghost" onClick={addAccount}>
            + 添加账号
          </button>
          <button className="btn ghost" onClick={() => onRefresh()} title="先用当前已保存的配置刷新一次">
            刷新数据
          </button>
          <button className="btn primary" onClick={handleSaveAll} disabled={saving}>
            {saving ? "保存中…" : "保存全部"}
          </button>
        </div>
      </div>

      {savedTip && <div className="save-tip">{savedTip}</div>}

      {cfgPath && (
        <p className="muted small config-path">
          配置文件：<code>{cfgPath}</code>
        </p>
      )}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p className="muted">还没有账号，点击「添加账号」开始。</p>
        </div>
      ) : (
        <table className="accounts-table">
          <thead>
            <tr>
              <th>启用</th>
              <th>名称</th>
              <th>类型</th>
              <th>Base URL</th>
              <th>认证</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className={a.enabled ? "" : "disabled-row"}>
                <td>
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={() => toggleEnabled(a.id)}
                  />
                </td>
                <td className="cell-name">{a.name || <span className="muted">（未命名）</span>}</td>
                <td>{PROVIDER_KINDS.find((k) => k.value === a.kind)?.label ?? a.kind}</td>
                <td className="cell-url" title={a.baseUrl}>
                  {a.baseUrl}
                </td>
                <td>
                  {a.token
                    ? "Token"
                    : a.apiKey
                      ? "API Key"
                      : a.username
                        ? "账号密码"
                        : a.custom
                          ? "自定义"
                          : "—"}
                </td>
                <td className="cell-actions">
                  <button className="link-btn" onClick={() => setEditing(a)}>
                    编辑
                  </button>
                  <button className="link-btn" onClick={() => duplicateAccount(a)}>
                    复制
                  </button>
                  <button className="link-btn danger" onClick={() => removeAccount(a.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="settings-section">
        <h3>通用设置</h3>
        <label className="setting-row">
          <span>自动刷新间隔（秒，0 = 关闭）</span>
          <input
            type="number"
            min={0}
            max={86400}
            value={autoRefreshSec}
            onChange={(e) => setAutoRefreshSec(Number(e.target.value))}
            style={{ width: 100 }}
          />
        </label>
        <label className="setting-row">
          <span>启动时自动刷新一次</span>
          <input
            type="checkbox"
            checked={refreshOnStart}
            onChange={(e) => setRefreshOnStart(e.target.checked)}
          />
        </label>
        <label className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 5 }}>
          <span>网络代理（可选，全部查询共用）</span>
          <input
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，留空则不走代理"
            style={{ width: "100%" }}
          />
        </label>
        <p className="muted small">
          访问 OpenAI 等境外官方接口通常需要代理；中转站和国内厂商一般直连即可。
          API Key / Token 只保存在本机配置文件中，不会上传到任何服务器（查询请求直连各提供商）。
        </p>
      </div>
    </main>
  );
}
