export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: string;
}

function apiUrl(path: string, apiBaseUrl?: string) {
  const base = (apiBaseUrl || import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
  return `${base}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}, apiBaseUrl?: string): Promise<T> {
  const response = await fetch(apiUrl(path, apiBaseUrl), {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String(payload.detail || `HTTP ${response.status}`));
  }
  const payload = await response.json();
  return (payload.data ?? payload) as T;
}

export const authApi = {
  me(apiBaseUrl?: string) {
    return request<AuthUser>("/api/auth/me", {}, apiBaseUrl);
  },
  login(username: string, password: string, apiBaseUrl?: string) {
    return request<AuthUser>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }, apiBaseUrl);
  },
  register(username: string, password: string, apiBaseUrl?: string) {
    return request<AuthUser>("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }, apiBaseUrl);
  },
  async logout(apiBaseUrl?: string) {
    await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }, apiBaseUrl);
  },
};
