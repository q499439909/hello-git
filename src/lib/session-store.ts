import type { ChatMessage } from "./chat-events";
import type { WorkspaceProject, WorkspaceSession } from "../types";

export interface StoredConversationSnapshot {
  messages: ChatMessage[];
  projectName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export function promoteConversationSnapshot<T extends StoredConversationSnapshot>(
  snapshots: Record<string, T>,
  temporaryKey: string,
  persistedKey: string,
  patch: Partial<T> & { remoteSessionId?: string },
): Record<string, T> {
  const temporary = snapshots[temporaryKey];
  const persisted = snapshots[persistedKey];
  if (!temporary && !persisted) return snapshots;

  const next = { ...snapshots };
  next[persistedKey] = {
    ...(persisted || {}),
    ...(temporary || {}),
    ...patch,
  } as T;
  if (temporaryKey !== persistedKey) delete next[temporaryKey];
  return next;
}

export function isActiveWorkspaceSession(
  activeAppId: string,
  activeSessionId: string,
  session: Pick<WorkspaceSession, "app_id" | "session_id">,
) {
  return session.app_id === activeAppId && session.session_id === activeSessionId;
}

export function selectPersistedSession<T extends Pick<WorkspaceSession, "session_id" | "app_id">>(
  sessions: T[],
  requestedSessionId: string | null,
  currentAppId: string,
): T | undefined {
  const requested = sessions.find((item) => item.session_id === requestedSessionId);
  if (requested) return requested;
  if (requestedSessionId?.startsWith(`new:${currentAppId}:`)) return undefined;
  return sessions.find((item) => item.app_id === currentAppId) || sessions[0];
}

function conversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((item) => item.role === "user")?.content.trim();
  if (!firstUserMessage) return "新会话";
  const compact = firstUserMessage.replace(/\s+/g, " ");
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

export function mergeSnapshotSessions<T extends StoredConversationSnapshot>(
  projects: WorkspaceProject[],
  snapshots: Record<string, T>,
): WorkspaceProject[] {
  const result = projects.map((project) => ({
    ...project,
    sessions: [...project.sessions],
  }));
  const activityBySession = new Map<string, number>();

  for (const [conversationKey, snapshot] of Object.entries(snapshots)) {
    const separator = conversationKey.indexOf(":");
    if (separator <= 0) continue;
    const appId = conversationKey.slice(0, separator);
    const sessionId = conversationKey.slice(separator + 1);
    if (!sessionId) continue;

    const activityAt = snapshot.updatedAt
      || (sessionId.startsWith("new:") ? snapshot.createdAt : undefined);
    if (activityAt) activityBySession.set(`${appId}:${sessionId}`, activityAt);

    let project = result.find((item) => item.app_id === appId);
    if (!project) {
      project = {
        app_id: appId,
        name: snapshot.projectName || appId,
        sessions: [],
      };
      result.push(project);
    }
    if (!project.sessions.some((item) => item.session_id === sessionId)) {
      const session: WorkspaceSession = {
        session_id: sessionId,
        app_id: appId,
        project_name: snapshot.projectName || project.name,
        title: conversationTitle(Array.isArray(snapshot.messages) ? snapshot.messages : []),
        time: "刚刚",
      };
      project.sessions.push(session);
    }
  }

  for (const project of result) {
    project.sessions = project.sessions
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const leftActivity = activityBySession.get(`${project.app_id}:${left.session.session_id}`);
        const rightActivity = activityBySession.get(`${project.app_id}:${right.session.session_id}`);
        if (leftActivity !== undefined || rightActivity !== undefined) {
          return (rightActivity || 0) - (leftActivity || 0);
        }
        return left.index - right.index;
      })
      .map(({ session }) => session);
  }
  return result;
}
