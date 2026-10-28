import { useEffect, useRef, useState } from "react";
import * as api from "../api";

interface Props {
  baseUrl: string;
  hasCredential: boolean;
  disabled?: boolean;
  onConnected: (refreshToken: string) => void;
  onBusyChange: (busy: boolean) => void;
}

export default function ModelServerLogin({ baseUrl, hasCredential, disabled = false, onConnected, onBusyChange }: Props) {
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<api.ModelServerLoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (id) void api.cancelModelServerLogin(id).catch(() => {});
    onBusyChange(false);
  }, [onBusyChange]);

  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await api.modelserverLoginStatus(pending.attemptId);
        if (disposed || active.current !== pending.attemptId) return;
        if (status.status === "pending") {
          timer = window.setTimeout(poll, 800);
          return;
        }
        active.current = null;
        setPending(null);
        setError(status.status === "failed" ? status.message : null);
        if (status.status === "complete") connected.current(status.refreshToken);
      } catch (e) {
        if (disposed || active.current !== pending.attemptId) return;
        active.current = null;
        setPending(null);
        setError(String(e));
        void api.cancelModelServerLogin(pending.attemptId).catch(() => {});
      }
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [pending]);

  const begin = async () => {
    const version = ++generation.current;
    setStarting(true);
    setError(null);
    try {
      const flow = await api.startModelServerLogin(baseUrl);
      if (version !== generation.current) {
        await api.cancelModelServerLogin(flow.attemptId);
        return;
      }
      active.current = flow.attemptId;
      setPending(flow);
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
    try { if (id) await api.cancelModelServerLogin(id); }
    catch (e) { if (version === generation.current) setError(String(e)); }
    finally { if (version === generation.current) setStarting(false); }
  };

  const reopen = async () => {
    if (!pending) return;
    const version = generation.current;
    const id = pending.attemptId;
    try {
      await api.openModelServerLogin(id);
      if (version === generation.current && active.current === id) setError(null);
    } catch (e) {
      if (version === generation.current && active.current === id) setError(String(e));
    }
  };

  const busy = starting || pending !== null;
  return <div className="form-field wide modelserver-login">
    <span>ModelServer 网页登录</span>
    <div className="auth-file-row">
      <button type="button" className="btn primary" onClick={begin} disabled={busy || disabled || !baseUrl.trim()}>
        {busy ? "等待网页登录…" : hasCredential ? "重新网页登录" : "使用网页登录"}
      </button>
      {busy && <button type="button" className="btn" onClick={cancel}>取消登录</button>}
      {pending && <button type="button" className="btn" onClick={reopen} disabled={disabled}>打开登录窗口</button>}
    </div>
    <em className="field-hint">在应用内窗口完成面板登录，返回面板后自动读取 refresh_token，无需 F12。外部浏览器无法回填凭据。</em>
    {hasCredential && !busy && <span role="status">已填写 refresh_token，可测试连接后保存。</span>}
    {pending && <>
      <span role="status">请在应用内窗口完成授权，最多等待 5 分钟。登录成功后窗口会自动关闭。</span>
      <input aria-label="ModelServer 面板地址" value={pending.authUrl} readOnly onFocus={(e) => e.target.select()} />
    </>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
