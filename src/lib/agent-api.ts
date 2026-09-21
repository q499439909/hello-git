export interface AgentSessionInput {
  appId: string;
  model: string;
}

export interface AgentStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface AgentSessionStatus {
  sessionId: string;
  runId: string;
  model: string;
  switchRevision: number;
  status: string;
}

export interface AgentModelSwitch extends AgentSessionStatus {
  previousModel: string;
  contextInherited: boolean;
}

export interface PersistedAgentSession {
  id: string;
  app_id: string;
  title: string;
  model: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PersistedChatMessage {
  id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  message_type: string;
  content: unknown;
  created_at: string;
}

function apiUrl(path: string, apiBaseUrl?: string) {
  const base = (apiBaseUrl || import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
  return `${base}${path}`;
}

async function createSession(input: AgentSessionInput, apiBaseUrl?: string) {
  const response = await fetch(apiUrl("/api/agent/sessions", apiBaseUrl), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      app_id: input.appId,
      model: input.model,
      stream: true,
    }),
  });
  if (!response.ok) throw new Error(`Unable to create agent session: HTTP ${response.status}`);
  const payload = await response.json();
  const sessionId = String(payload.session_id || payload.data?.session_id || "").trim();
  if (!sessionId) throw new Error("Agent session response is missing session_id");
  const model = String(payload.model || payload.data?.model || "").trim();
  if (!model) throw new Error("Agent session response is missing model");
  return {
    sessionId,
    runId: String(payload.run_id || payload.data?.run_id || "").trim(),
    model,
    switchRevision: Number(payload.switch_revision || payload.data?.switch_revision || 0),
    status: String(payload.status || payload.data?.status || "idle"),
  } satisfies AgentSessionStatus;
}

async function switchModel(sessionId: string, model: string, apiBaseUrl?: string) {
  const response = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/model`, apiBaseUrl), {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) throw new Error(`Unable to switch agent model: HTTP ${response.status}`);
  const payload = await response.json();
  return {
    sessionId: String(payload.session_id || "").trim(),
    runId: String(payload.run_id || "").trim(),
    previousModel: String(payload.previous_model || "").trim(),
    model: String(payload.model || "").trim(),
    contextInherited: Boolean(payload.context_inherited),
    switchRevision: Number(payload.switch_revision || 0),
    status: String(payload.status || "idle"),
  } satisfies AgentModelSwitch;
}

async function getSession(sessionId: string, apiBaseUrl?: string) {
  const response = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, apiBaseUrl), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unable to read agent session: HTTP ${response.status}`);
  const payload = await response.json();
  return {
    sessionId: String(payload.session_id || "").trim(),
    runId: String(payload.run_id || "").trim(),
    model: String(payload.model || "").trim(),
    switchRevision: Number(payload.switch_revision || 0),
    status: String(payload.status || "idle"),
  } satisfies AgentSessionStatus;
}

function extractText(event: AgentStreamEvent) {
  const data = event.data;
  const direct = data.delta ?? data.text ?? data.text_preview ?? data.content;
  if (typeof direct === "string") return direct;

  const choices = data.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as { delta?: { content?: unknown } } | undefined;
    if (typeof first?.delta?.content === "string") return first.delta.content;
  }
  return "";
}

async function streamMessage(
  sessionId: string,
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
  apiBaseUrl?: string,
) {
  const response = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, apiBaseUrl), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Agent stream failed: HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitBlock = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    if (raw === "[DONE]") {
      onEvent({ event: "done", data: {} });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      onEvent({ event, data: typeof parsed === "object" && parsed ? parsed : { text: String(parsed) } });
    } catch {
      onEvent({ event, data: { text: raw } });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(emitBlock);
    if (done) break;
  }
  if (buffer.trim()) emitBlock(buffer);
}

async function interruptSession(sessionId: string, apiBaseUrl?: string) {
  const response = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/interrupt`, apiBaseUrl), {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unable to interrupt agent session: HTTP ${response.status}`);
  return response.json() as Promise<{ accepted: boolean }>;
}

async function listSessions(apiBaseUrl?: string): Promise<PersistedAgentSession[]> {
  const response = await fetch(apiUrl("/api/agent/sessions", apiBaseUrl), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unable to list sessions: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.data?.items || payload.items || []) as PersistedAgentSession[];
}

async function listMessages(sessionId: string, apiBaseUrl?: string): Promise<PersistedChatMessage[]> {
  const response = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, apiBaseUrl), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Unable to list messages: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.data?.items || payload.items || []) as PersistedChatMessage[];
}

export const agentApi = {
  createSession, getSession, switchModel, streamMessage, interruptSession,
  listSessions, listMessages, extractText,
};
