import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { AgentWorkspace } from "./App";
import { authApi } from "./lib/auth-api";
import type { AuthUser } from "./lib/auth-api";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const appId = params.get("app_id") || "app_demo_2026";
const projectName = params.get("project_name") || "对话数据治理项目";

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    authApi.me().then(setUser).catch(() => undefined).finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="auth-shell"><div className="auth-card">正在加载…</div></div>;
  if (!user) {
    const submit = async (event: React.FormEvent) => {
      event.preventDefault();
      setSubmitting(true);
      setError("");
      try {
        const next = mode === "login"
          ? await authApi.login(username, password)
          : await authApi.register(username, password);
        setUser(next);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "操作失败，请重试");
      } finally {
        setSubmitting(false);
      }
    };
    return <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">Data Juicer</div>
        <h1>{mode === "login" ? "登录 Agent Workspace" : "注册平台账号"}</h1>
        <label>
          <span className="auth-label">用户名 <small>登录账号</small></span>
          <input required minLength={3} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          {mode === "register" && <span className="auth-field-hint">必须唯一，之后使用它登录。</span>}
        </label>
        <label>密码<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>{submitting ? "请稍候…" : mode === "login" ? "登录" : "注册"}</button>
        <button className="auth-switch" type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
          {mode === "login" ? "没有账号？立即注册" : "已有账号？返回登录"}
        </button>
      </form>
    </div>;
  }
  return <AgentWorkspace
    userId={user.id}
    username={user.display_name || user.username}
    appId={appId}
    projectName={projectName}
    onLogout={async () => { await authApi.logout(); setUser(null); }}
  />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthenticatedApp />
  </React.StrictMode>,
);
