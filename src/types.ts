export interface LlmModel {
  id: string;
  name?: string;
  owned_by?: string;
}

export interface WorkspaceSession {
  session_id: string;
  app_id: string;
  project_name: string;
  title: string;
  time?: string;
  user_message?: string;
  agent_message?: string;
}

export interface WorkspaceProject {
  app_id: string;
  name: string;
  sessions: WorkspaceSession[];
}

export interface AgentWorkspaceProps {
  userId: string;
  username?: string;
  appId: string;
  projectName?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  projects?: WorkspaceProject[];
  onExit?: () => void;
  onAddProject?: () => void;
  onProjectChange?: (project: WorkspaceProject) => void;
  onSelectSession?: (session: WorkspaceSession) => void;
  onLogout?: () => void;
}
