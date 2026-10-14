import { useEffect, useState } from "react";
import type { AccountConfig, AppConfig, CustomQuery, KeyValue, ProviderKind } from "../types";
import { PROVIDER_KINDS, DEFAULT_BASE_URLS, newAccountId } from "../types";
import AccountForm from "./AccountForm";
import * as api from "../api";

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
  onRefresh: () => Promise<void>;
  /** 外部「添加账号（预选类型）」请求（新手引导 / 空状态步骤），nonce 判重 */
  addRequest?: { kind: ProviderKind; nonce: number } | null;
  /** 请求被消费后调用，App 据此清除（防重挂载复开表单） */
  onAddRequestHandled?: () => void;
}

export default function SettingsView({ config, onSave, onRefresh, addRequest, onAddRequestHandled }: Props) {
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
      showTip(`保存失败：${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const addAccount = (kind: ProviderKind = "newApi") => {
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

  // 消费外部「添加账号（预选类型）」请求：打开表单后通知 App 清除，避免切视图重挂载时复开
  useEffect(() => {
    if (addRequest) {
      addAccount(addRequest.kind);
      onAddRequestHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addRequest, onAddRequestHandled]);

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

  // 表格行键盘导航：↑↓ 在行间移动焦点，Enter/Space 打开编辑（仅当焦点在行本身，不拦截行内按钮的原生行为）
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, acc: AccountConfig) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll("tr") ?? []);
      const i = rows.indexOf(e.currentTarget);
      const next = rows[e.key === "ArrowDown" ? i + 1 : i - 1] as HTMLElement | undefined;
      next?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      setEditing(acc);
    }
  };

  const handleExport = async () => {
    try {
      const path = await api.pickExportPath();
      if (!path) return;
      await api.exportConfig(path);
      showTip(`已导出到 ${path}`);
    } catch (e) {
      showTip(`导出失败：${String(e)}`);
    }
  };

  const handleImport = async () => {
    // 注意：不能用 window.confirm —— macOS WKWebView 下它不弹窗且返回 undefined
    const confirmed = await api.confirmDialog(
      "导入会替换通用设置，账号按 ID 合并（同 ID 覆盖、新 ID 追加），当前未保存的编辑会丢失。继续？",
    );
    if (!confirmed) return;
    try {
      const path = await api.pickImportPath();
      if (!path) return;
      const merged = await api.importConfig(path);
      setAccounts(merged.accounts);
      setAutoRefreshSec(merged.settings.autoRefreshSec);
      setRefreshOnStart(merged.settings.refreshOnStart);
      setProxy(merged.settings.proxy ?? "");
      showTip(`已导入 ${merged.accounts.length} 个账号`);
    } catch (e) {
      showTip(`导入失败：${String(e)}`);
    }
  };

  if (editing) {
    return (
      <main className="main">
        <div className="settings-header">
          <div className="settings-title-group">
            <button className="link-btn back-btn" onClick={() => setEditing(null)}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M6.5 1.8 3.3 5l3.2 3.2" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              返回账号列表
            </button>
            <h2>{accounts.some((a) => a.id === editing.id) ? "编辑账号" : "添加账号"}</h2>
          </div>
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
          <button className="btn ghost" onClick={() => addAccount()}>
            + 添加账号
          </button>
          <button className="btn ghost" onClick={() => onRefresh()} title="先用当前已保存的配置刷新一次">
            刷新数据
          </button>
          <button className="btn ghost" onClick={handleImport} title="从导出的配置文件合并账号（跨设备迁移）">
            导入配置
          </button>
          <button className="btn ghost" onClick={handleExport} title="导出全部账号与设置（含 API Key）">
            导出配置
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
        <div className="accounts-table-wrap">
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
              {accounts.map((a) => {
                const kindMeta = PROVIDER_KINDS.find((k) => k.value === a.kind);
                const authLabel = a.token
                  ? "Token"
                  : a.apiKey
                    ? "API Key"
                    : a.username
                      ? "账号密码"
                      : a.custom
                        ? "自定义"
                        : null;
                return (
                  <tr
                    key={a.id}
                    className={a.enabled ? "" : "disabled-row"}
                    tabIndex={0}
                    onKeyDown={(e) => onRowKeyDown(e, a)}
                    aria-label={`账号 ${a.name || "未命名"}，回车编辑`}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="switch"
                        checked={a.enabled}
                        onChange={() => toggleEnabled(a.id)}
                        aria-label={`启用 ${a.name || "未命名账号"}`}
                        title={a.enabled ? "点击停用" : "点击启用"}
                      />
                    </td>
                    <td className="cell-name">{a.name || <span className="muted">（未命名）</span>}</td>
                    <td>
                      <span className={`badge ${kindMeta?.group === "官方" ? "badge-official" : "badge-relay"}`}>
                        {kindMeta?.label ?? a.kind}
                      </span>
                    </td>
                    <td className="cell-url" title={a.baseUrl}>
                      {a.baseUrl}
                    </td>
                    <td>
                      {authLabel ? <span className="badge badge-auth">{authLabel}</span> : <span className="muted">—</span>}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {accounts.length > 0 && (
        <p className="muted small table-kbd-hint">
          提示：<kbd>Tab</kbd> 聚焦行后 <kbd>↑</kbd>
          <kbd>↓</kbd> 移动，<kbd>Enter</kbd> 编辑；行内按钮仍可 Tab 直达。
        </p>
      )}

      <div className="settings-section">
        <h3>通用设置</h3>
        <label className="setting-row">
          <span>自动刷新间隔（秒，0 = 关闭）</span>
          <input
            type="number"
            min={0}
            max={86400}
            className="input-compact"
            value={autoRefreshSec}
            onChange={(e) => setAutoRefreshSec(Number(e.target.value))}
          />
        </label>
        <label className="setting-row">
          <span>启动时自动刷新一次</span>
          <input
            type="checkbox"
            className="switch"
            checked={refreshOnStart}
            onChange={(e) => setRefreshOnStart(e.target.checked)}
          />
        </label>
        <label className="setting-row column">
          <span>网络代理（可选，全部查询共用）</span>
          <input
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，留空则不走代理"
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
