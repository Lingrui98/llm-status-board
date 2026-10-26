import { useEffect, useRef, useState } from "react";
import * as api from "../api";

interface Props {
  authId?: string | null;
  onConnected: (authId: string, accountId: string | null) => void;
  onDisconnect: () => void;
  onBusyChange: (busy: boolean) => void;
}

export default function ChatgptLogin({ authId, onConnected, onDisconnect, onBusyChange }: Props) {
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<api.ChatgptLoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const active = useRef<string | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  useEffect(() => {
    onBusyChange(starting || pending !== null);
  }, [starting, pending, onBusyChange]);

  useEffect(() => () => {
    generation.current++;
    const id = active.current;
    active.current = null;
    if (id) void api.cancelChatgptLogin(id).catch(() => {});
    onBusyChange(false);
  }, [onBusyChange]);

  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await api.chatgptLoginStatus(pending.attemptId);
        if (disposed || active.current !== pending.attemptId) {
          if (status.status === "complete") void api.discardChatgptAuth(status.authId).catch(() => {});
          return;
        }
        if (status.status === "pending") {
          timer = window.setTimeout(poll, 800);
          return;
        }
        active.current = null;
        setPending(null);
        setError(status.status === "failed" ? status.message : null);
        if (status.status === "complete") connected.current(status.authId, status.accountId);
      } catch (e) {
        if (disposed || active.current !== pending.attemptId) return;
        active.current = null;
        setPending(null);
        setError(String(e));
        void api.cancelChatgptLogin(pending.attemptId).catch(() => {});
      }
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [pending]);

  const begin = async () => {
    const version = ++generation.current;
    setStarting(true);
    setError(null);
    setCopied(false);
    try {
      const flow = await api.startChatgptLogin();
      if (version !== generation.current) {
        await api.cancelChatgptLogin(flow.attemptId);
        return;
      }
      active.current = flow.attemptId;
      setPending(flow);
      try { await api.openChatgptLogin(flow.attemptId); }
      catch (e) { if (active.current === flow.attemptId) setError(String(e)); }
    } catch (e) {
      if (version === generation.current) setError(String(e));
    } finally {
      if (version === generation.current) setStarting(false);
    }
  };

  const cancel = async () => {
    const version = ++generation.current;
    const id = active.current;
    active.current = null;
    setPending(null);
    setStarting(true);
    setError(null);
    try { if (id) await api.cancelChatgptLogin(id); }
    catch (e) { if (version === generation.current) setError(String(e)); }
    finally { if (version === generation.current) setStarting(false); }
  };

  const reopen = async () => {
    if (!pending) return;
    try { await api.openChatgptLogin(pending.attemptId); setError(null); }
    catch (e) { setError(String(e)); }
  };

  const copy = async () => {
    if (!pending) return;
    try { await navigator.clipboard.writeText(pending.authUrl); setCopied(true); }
    catch { setError("剪贴板不可用，请选中下方登录链接复制"); }
  };

  const busy = starting || pending !== null;
  return <div className="form-field wide chatgpt-login">
    <span>ChatGPT 登录</span>
    <div className="auth-file-row">
      <button type="button" className="btn primary" onClick={begin} disabled={busy}>
        {busy ? "等待浏览器登录…" : authId ? "重新登录 ChatGPT" : "使用 ChatGPT 登录"}
      </button>
      {busy && <button type="button" className="btn" onClick={cancel}>取消登录</button>}
      {authId && !busy && <button type="button" className="btn" onClick={onDisconnect}>断开登录</button>}
    </div>
    <em className="field-hint">通过官方 Codex 授权流程连接，无需安装 Codex。在浏览器完成授权后返回这里；登录后自动续期。</em>
    {authId && <span role="status">ChatGPT 已连接，保存后即可监控 Codex 额度。</span>}
    <em className="field-hint">连接或断开后，请点击「确定」保存。</em>
    {pending && <>
      <span role="status">请在此电脑的浏览器完成登录，等待时间最多 5 分钟。</span>
      <div className="auth-file-row">
        <button type="button" className="link-btn" onClick={reopen}>打开登录页面</button>
        <button type="button" className="link-btn" onClick={copy}>{copied ? "已复制" : "复制登录链接"}</button>
      </div>
      <input aria-label="ChatGPT 登录链接" value={pending.authUrl} readOnly onFocus={(e) => e.target.select()} />
    </>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
