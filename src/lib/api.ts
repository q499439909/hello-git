import type { LlmModel } from "../types";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const previewModels: LlmModel[] = [
  { id: "qwen3-max", name: "Qwen3 Max", owned_by: "model-service" },
  { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", owned_by: "model-service" },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", owned_by: "model-service" },
];

function asArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ["data", "list", "items", "records", "result"]) {
    const value = obj[key];
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === "object") {
      const nested = asArray<T>(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function query(path: string, params: Record<string, string>, apiBaseUrl?: string) {
  const base = (apiBaseUrl || import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
  const url = new URL(`${base}${path}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return base ? url.toString() : `${url.pathname}${url.search}`;
}

export const llmApi = {
  async listModels(apiBaseUrl?: string): Promise<{ items: LlmModel[]; preview: boolean; defaultModel?: string }> {
    try {
      const response = await fetch(query("/api/llm/models", {}, apiBaseUrl), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const items = asArray<LlmModel>(payload);
      const defaultModel = String(payload?.data?.default_model || "").trim() || undefined;
      return { items: items.length ? items : previewModels, preview: !items.length, defaultModel };
    } catch {
      await wait(260);
      return { items: previewModels, preview: true };
    }
  },
};
