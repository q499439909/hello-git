export interface ArtifactItem {
  id: string;
  app_id: string;
  run_id: string;
  name: string;
  kind: "json" | "jsonl" | "parquet" | "image" | "text" | "binary";
  role: string;
  format: string;
  mime_type: string;
  byte_size: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface PreviewDescriptor {
  artifact_id: string;
  viewer: "json" | "table" | "image" | "text" | "download-only";
  name: string;
  mime_type: string;
  byte_size: number;
  metadata: Record<string, unknown>;
  content_url?: string;
  thumbnail_url?: string;
  download_url: string;
  data_url?: string;
  records_url?: string;
  text_url?: string;
}

export interface RecordsPreview {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  offset: number;
  limit: number;
  has_more: boolean;
}

function baseUrl(apiBaseUrl?: string) {
  return (apiBaseUrl || import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
}

function url(path: string, apiBaseUrl?: string) {
  return `${baseUrl(apiBaseUrl)}${path}`;
}

async function get<T>(path: string, apiBaseUrl?: string): Promise<T> {
  const response = await fetch(url(path, apiBaseUrl), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const payload = await response.json();
  return (payload.data ?? payload) as T;
}

export const artifactApi = {
  async initializeProject(appId: string, projectName: string, apiBaseUrl?: string) {
    const response = await fetch(url(`/api/dj/v1/projects/${encodeURIComponent(appId)}/initialize`, apiBaseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ project_name: projectName }),
    });
    if (!response.ok) throw new Error(`项目初始化失败：HTTP ${response.status}`);
  },
  list(appId: string, apiBaseUrl?: string) {
    return get<{ items: ArtifactItem[] }>(`/api/dj/v1/projects/${encodeURIComponent(appId)}/artifacts`, apiBaseUrl);
  },
  descriptor(artifactId: string, apiBaseUrl?: string) {
    return get<PreviewDescriptor>(`/api/dj/v1/artifacts/${encodeURIComponent(artifactId)}/preview-descriptor`, apiBaseUrl);
  },
  json(artifactId: string, apiBaseUrl?: string) {
    return get<unknown>(`/api/dj/v1/artifacts/${encodeURIComponent(artifactId)}/json`, apiBaseUrl);
  },
  records(artifactId: string, offset = 0, apiBaseUrl?: string) {
    return get<RecordsPreview>(
      `/api/dj/v1/artifacts/${encodeURIComponent(artifactId)}/records?offset=${offset}&limit=100`,
      apiBaseUrl,
    );
  },
  text(artifactId: string, apiBaseUrl?: string) {
    return get<{ text: string; has_more: boolean }>(
      `/api/dj/v1/artifacts/${encodeURIComponent(artifactId)}/text?limit=262144`,
      apiBaseUrl,
    );
  },
  absolute(path: string | undefined, apiBaseUrl?: string) {
    return path ? url(path, apiBaseUrl) : "";
  },
};
