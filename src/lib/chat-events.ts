import type { AgentStreamEvent } from "./agent-api";

export type ToolEvent = {
  kind: "call" | "output";
  callId: string;
  tool: string;
  ok?: boolean;
  summary?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  turnId?: string;
  toolEvent?: ToolEvent;
};

function formatPayload(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null || value === "") return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function mergeStreamText(current: string, incoming: string, eventName: string, mode?: unknown) {
  if (!incoming) return current;
  // The backend has already converted these snapshots into genuine deltas.
  if (mode === "append") return current + incoming;
  if (!current) return incoming;
  if (incoming === current) return current;

  // Some OpenAI-compatible gateways label cumulative snapshots as deltas.
  // Replace those snapshots instead of appending the already-rendered prefix.
  if (incoming.length > current.length && incoming.startsWith(current)) return incoming;
  if (eventName === "message" && current.startsWith(incoming)) return current;
  return current + incoming;
}

export function toolMessageFromEvent(
  eventName: AgentStreamEvent["event"],
  data: AgentStreamEvent["data"],
  turnId?: string,
): ChatMessage | null {
  if (eventName !== "tool_start" && eventName !== "tool_end") return null;
  const tool = String(data.tool || "unknown_tool");
  const callId = String(data.call_id || `${tool}-${Date.now()}`);

  if (eventName === "tool_start") {
    return {
      id: `${turnId || ""}:${callId}-call`,
      turnId,
      role: "tool",
      content: formatPayload(data.args) || "无参数",
      toolEvent: { kind: "call", callId, tool },
    };
  }

  const ok = data.ok !== false;
  const preview = formatPayload(data.result_preview || data.failure_preview);
  const summary = formatPayload(data.summary);
  return {
    id: `${turnId || ""}:${callId}-output`,
    turnId,
    role: "tool",
    content: [summary, preview].filter(Boolean).join("\n"),
    toolEvent: { kind: "output", callId, tool, ok, summary },
  };
}

export type ToolCall = {
  callId: string;
  tool: string;
  input?: string;
  output?: string;
  summary?: string;
  ok?: boolean;
};

export type ChatTurn = {
  id: string;
  user?: ChatMessage;
  replies: ChatMessage[];
  tools: ToolCall[];
};

export function groupChatTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const byId = new Map<string, ChatTurn>();
  let current: ChatTurn | undefined;
  for (const message of messages) {
    // Old saved conversations have no turnId: a user message starts a turn.
    const id = message.turnId || (message.role === "user" ? message.id : current?.id) || message.id;
    let turn = byId.get(id);
    if (!turn) {
      turn = { id, replies: [], tools: [] };
      turns.push(turn);
      byId.set(id, turn);
    }
    current = turn;
    if (message.role === "user") turn.user = message;
    else if (message.role === "assistant") turn.replies.push(message);
    else if (message.toolEvent) {
      const event = message.toolEvent;
      let call = turn.tools.find((item) => item.callId === event.callId);
      if (!call) {
        call = { callId: event.callId, tool: event.tool };
        turn.tools.push(call);
      }
      if (event.kind === "call") call.input = message.content;
      else {
        call.output = message.content;
        call.ok = event.ok !== false;
        call.summary = event.summary || message.content.split("\n")[0];
      }
    }
  }
  return turns;
}
