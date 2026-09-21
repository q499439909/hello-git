import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Archive,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { llmApi } from "./lib/api";
import { agentApi } from "./lib/agent-api";
import { groupChatTurns, mergeStreamText, toolMessageFromEvent } from "./lib/chat-events";
import type { ChatMessage } from "./lib/chat-events";
import {
  isActiveWorkspaceSession,
  mergeSnapshotSessions,
  promoteConversationSnapshot,
  selectPersistedSession,
} from "./lib/session-store";
import { ArtifactLibrary } from "./ArtifactLibrary";
import { ToolTrace } from "./ToolTrace";
import type { AgentWorkspaceProps, LlmModel, WorkspaceProject, WorkspaceSession } from "./types";

const sessionCopy = [
  { session_id: "session_cleanup", title: "清理重复与低质量对话", time: "刚刚", user_message: "去除重复对话，并过滤过短或包含敏感信息的样本", agent_message: "已关联当前项目的数据集。我会先检查重复率、文本长度和敏感字段，再生成可确认的处理方案。" },
  { session_id: "session_privacy", title: "检查敏感信息与隐私字段", time: "昨天", user_message: "检查数据中的手机号、邮箱和其他隐私字段", agent_message: "已完成字段扫描准备，将按类型统计潜在隐私信息并给出脱敏建议。" },
  { session_id: "session_multimodal", title: "分析多模态样本质量", time: "09-16", user_message: "分析图文样本的匹配度和质量分布", agent_message: "我会检查图文对应关系、异常样本与质量分布，并生成分析结果。" },
  { session_id: "session_report", title: "生成数据质量报告", time: "09-12", user_message: "生成这个数据集的质量报告", agent_message: "已恢复质量报告会话，可以继续补充指标或重新执行。" },
  { session_id: "session_empty", title: "去除空值与无效轮次", time: "09-08", user_message: "删除空值以及无效的对话轮次", agent_message: "已恢复清洗会话，当前方案会保留有效多轮上下文。" },
  { session_id: "session_roles", title: "统一对话角色字段", time: "09-03", user_message: "统一 user 和 assistant 的角色字段", agent_message: "已恢复字段标准化会话。" },
];

const imageSessionCopy = [
  { session_id: "session_image_pipeline", title: "图片管线质量检查", time: "6天", user_message: "检查图片处理管线的质量问题", agent_message: "已进入图像数据质量治理项目。我会检查人脸尺寸、清晰度、水印和内容安全等质量项。" },
  { session_id: "session_image_outliers", title: "分析异常样本分布", time: "8天", user_message: "分析图片异常样本的分布", agent_message: "已恢复异常样本分析会话，可以继续查看分布结果或调整筛选条件。" },
];

type PickerKey = "model" | null;
type ConversationSnapshot = {
  messages: ChatMessage[];
  remoteSessionId?: string;
  model?: LlmModel | null;
  confirmedModelId?: string;
  modelStatus?: string;
  projectName?: string;
  createdAt?: number;
  updatedAt?: number;
};

export function AgentWorkspace({
  userId,
  username,
  appId,
  projectName = "当前项目",
  apiBaseUrl,
  defaultModel,
  projects,
  onExit,
  onAddProject,
  onProjectChange,
  onSelectSession,
  onLogout,
}: AgentWorkspaceProps) {
  const [persistedSessions, setPersistedSessions] = useState<WorkspaceSession[]>([]);
  const baseWorkspaceProjects = useMemo<WorkspaceProject[]>(() => {
    if (projects?.length) return projects;
    const grouped = new Map<string, WorkspaceProject>();
    for (const session of persistedSessions) {
      const current = grouped.get(session.app_id) || {
        app_id: session.app_id,
        name: session.app_id === appId ? projectName : session.project_name,
        sessions: [],
      };
      current.sessions.push(session);
      grouped.set(session.app_id, current);
    }
    if (!grouped.has(appId)) grouped.set(appId, { app_id: appId, name: projectName, sessions: [] });
    return [...grouped.values()];
  }, [appId, projectName, projects, persistedSessions]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
  const [picker, setPicker] = useState<PickerKey>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [model, setModel] = useState<LlmModel | null>(null);
  const [confirmedModelId, setConfirmedModelId] = useState("");
  const [modelStatus, setModelStatus] = useState("");
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [activeProject, setActiveProject] = useState(() => ({ app_id: appId, name: projectName }));
  const [activeSession, setActiveSession] = useState(() => {
    const requestedSession = new URLSearchParams(window.location.search).get("session_id");
    return requestedSession || `new:${appId}:${Date.now()}`;
  });
  const [conversationSnapshots, setConversationSnapshots] = useState<Record<string, ConversationSnapshot>>({});
  const workspaceProjects = useMemo(
    () => mergeSnapshotSessions(baseWorkspaceProjects, conversationSnapshots),
    [baseWorkspaceProjects, conversationSnapshots],
  );
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => ({ [appId]: true, app_image_quality_2026: true }));
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showOtherProjects, setShowOtherProjects] = useState(true);
  const [workspacePanel, setWorkspacePanel] = useState<"search" | "add" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [attachmentName, setAttachmentName] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const sessionIdRef = useRef("");
  const skipConversationHydrationRef = useRef("");
  const hydratedConversationKeyRef = useRef("");
  const receivedTextRef = useRef("");
  const assistantMessageIdRef = useRef("");
  const activeTurnIdRef = useRef("");
  const followOutputRef = useRef(true);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const activeConversationKey = `${activeProject.app_id}:${activeSession}`;
  const turns = useMemo(() => groupChatTurns(messages), [messages]);
  // Tool payload updates must not scroll the conversation.
  const visibleText = messages.filter((item) => item.role !== "tool")
    .map((item) => `${item.id}:${item.content}`).join("\n");

  useEffect(() => {
    let previousY = window.scrollY;
    const onScroll = () => {
      if (window.scrollY < previousY) followOutputRef.current = false;
      else if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 100) {
        followOutputRef.current = true;
      }
      previousY = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setActiveProject({ app_id: appId, name: projectName });
    setExpandedProjects((value) => ({ ...value, [appId]: true }));
  }, [appId, projectName]);

  useEffect(() => {
    let active = true;
    const loadPersistedConversations = async () => {
      try {
        const sessions = await agentApi.listSessions(apiBaseUrl);
        const nextSnapshots: Record<string, ConversationSnapshot> = {};
        const nextSessions: WorkspaceSession[] = [];
        for (const session of sessions) {
          const records = await agentApi.listMessages(session.id, apiBaseUrl);
          let turnId = "";
          const restored: ChatMessage[] = [];
          for (const record of records) {
            if (record.role === "user") {
              turnId = record.id;
              restored.push({ id: record.id, turnId, role: "user", content: String(record.content ?? "") });
            } else if (record.role === "assistant") {
              restored.push({ id: record.id, turnId: turnId || record.id, role: "assistant", content: String(record.content ?? "") });
            } else if (record.role === "tool" && record.content && typeof record.content === "object") {
              const tool = toolMessageFromEvent(record.message_type, record.content as Record<string, unknown>, turnId || undefined);
              if (tool) restored.push({ ...tool, id: record.id });
            }
          }
          const key = `${session.app_id}:${session.id}`;
          nextSnapshots[key] = {
            messages: restored,
            remoteSessionId: session.id,
            confirmedModelId: session.model,
            modelStatus: session.model ? `当前使用 ${session.model} 模型` : "",
            projectName: session.app_id === appId ? projectName : session.app_id,
            createdAt: Date.parse(session.created_at),
            updatedAt: Date.parse(session.updated_at),
          };
          nextSessions.push({
            session_id: session.id,
            app_id: session.app_id,
            project_name: session.app_id === appId ? projectName : session.app_id,
            title: session.title || "新会话",
            time: new Date(session.updated_at).toLocaleDateString("zh-CN"),
          });
        }
        if (!active) return;
        setConversationSnapshots(nextSnapshots);
        setPersistedSessions(nextSessions);
        const requested = new URLSearchParams(window.location.search).get("session_id");
        const selected = selectPersistedSession(nextSessions, requested, appId);
        if (selected) {
          setActiveProject({ app_id: selected.app_id, name: selected.project_name });
          setActiveSession(selected.session_id);
          sessionIdRef.current = selected.session_id;
          const selectedUrl = new URL(window.location.href);
          selectedUrl.searchParams.set("app_id", selected.app_id);
          selectedUrl.searchParams.set("project_name", selected.project_name);
          selectedUrl.searchParams.set("session_id", selected.session_id);
          window.history.replaceState(null, "", selectedUrl);
        }
      } catch {
        // Authentication is handled by the outer app; an empty history is valid.
      }
    };
    void loadPersistedConversations();
    return () => { active = false; };
  }, [userId, apiBaseUrl, appId, projectName]);

  useEffect(() => {
    let active = true;
    llmApi.listModels(apiBaseUrl).then(({ items, defaultModel: discoveredDefault }) => {
      if (!active) return;
      setModels(items);
      setModel((current) => items.find((item) => item.id === current?.id)
        || items.find((item) => item.id === defaultModel || item.id === discoveredDefault)
        || items[0]
        || null);
    });
    return () => { active = false; };
  }, [apiBaseUrl, defaultModel]);

  const refreshModels = async () => {
    const { items, defaultModel: discoveredDefault } = await llmApi.listModels(apiBaseUrl);
    setModels(items);
    setModel((current) => items.find((item) => item.id === current?.id)
      || items.find((item) => item.id === defaultModel || item.id === discoveredDefault)
      || items[0]
      || null);
  };

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPicker(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (skipConversationHydrationRef.current === activeConversationKey) {
      skipConversationHydrationRef.current = "";
      hydratedConversationKeyRef.current = activeConversationKey;
      return;
    }
    if (hydratedConversationKeyRef.current === activeConversationKey) return;
    const saved = conversationSnapshots[activeConversationKey];
    setConfirmedModelId(saved?.confirmedModelId || "");
    setModelStatus(saved?.modelStatus || "");
    if (saved) {
      hydratedConversationKeyRef.current = activeConversationKey;
      setMessages(saved.messages || []);
      sessionIdRef.current = saved.remoteSessionId || "";
      if (saved.model) setModel(saved.model);
    }
  }, [activeConversationKey, conversationSnapshots]);

  useEffect(() => {
    if (!messages.length) return;
    const timeout = window.setTimeout(() => {
      setConversationSnapshots((items) => ({
        ...items,
        [activeConversationKey]: {
          messages,
          remoteSessionId: sessionIdRef.current || undefined,
          model,
          confirmedModelId: confirmedModelId || undefined,
          modelStatus: modelStatus || undefined,
          projectName: activeProject.name,
          createdAt: items[activeConversationKey]?.createdAt || Date.now(),
          updatedAt: items[activeConversationKey]?.updatedAt,
        },
      }));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [activeConversationKey, messages, model, confirmedModelId, modelStatus, activeProject.name]);

  const appendStreamText = (text: string, eventName = "message.delta", mode?: unknown) => {
    if (!text) return;
    receivedTextRef.current = mergeStreamText(receivedTextRef.current, text, eventName, mode);
    const assistantId = assistantMessageIdRef.current;
    const content = receivedTextRef.current;
    const turnId = activeTurnIdRef.current;
    setMessages((items) => items.some((item) => item.id === assistantId)
      ? items.map((item) => item.id === assistantId ? { ...item, content } : item)
      : [...items, { id: assistantId, turnId, role: "assistant", content }]);
  };

  useEffect(() => {
    if (followOutputRef.current) conversationEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [visibleText]);

  const send = async () => {
    const text = message.trim();
    if (!text || !model || isStreaming) return;
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantId = `${turnId}-assistant`;
    const userMessage: ChatMessage = { id: `${turnId}-user`, turnId, role: "user", content: text };
    const interactionAt = Date.now();
    assistantMessageIdRef.current = assistantId;
    activeTurnIdRef.current = turnId;
    followOutputRef.current = true;
    setMessages((items) => [
      ...items,
      userMessage,
    ]);
    setConversationSnapshots((items) => ({
      ...items,
      [activeConversationKey]: {
        ...(items[activeConversationKey] || {}),
        messages: [...messages, userMessage],
        remoteSessionId: sessionIdRef.current || undefined,
        model,
        confirmedModelId: confirmedModelId || undefined,
        modelStatus: modelStatus || undefined,
        projectName: activeProject.name,
        createdAt: items[activeConversationKey]?.createdAt || interactionAt,
        updatedAt: interactionAt,
      },
    }));
    setMessage("");
    setIsStreaming(true);
    setIsStopping(false);
    receivedTextRef.current = "";

    try {
      if (!sessionIdRef.current) {
        const created = await agentApi.createSession({
          appId: activeProject.app_id,
          model: model.id,
        }, apiBaseUrl);
        sessionIdRef.current = created.sessionId;
        const persistedKey = `${activeProject.app_id}:${created.sessionId}`;
        skipConversationHydrationRef.current = persistedKey;
        setConversationSnapshots((items) => promoteConversationSnapshot(
          items,
          activeConversationKey,
          persistedKey,
          {
            messages: items[activeConversationKey]?.messages || [...messages, userMessage],
            remoteSessionId: created.sessionId,
            projectName: activeProject.name,
            updatedAt: interactionAt,
          },
        ));
        setPersistedSessions((items) => items.some((item) => item.session_id === created.sessionId)
          ? items
          : [{
              session_id: created.sessionId,
              app_id: activeProject.app_id,
              project_name: activeProject.name,
              title: text.slice(0, 80),
              time: "刚刚",
            }, ...items]);
        setActiveSession(created.sessionId);
        const persistedUrl = new URL(window.location.href);
        persistedUrl.searchParams.set("app_id", activeProject.app_id);
        persistedUrl.searchParams.set("project_name", activeProject.name);
        persistedUrl.searchParams.set("session_id", created.sessionId);
        window.history.replaceState(null, "", persistedUrl);
        const confirmed = models.find((item) => item.id === created.model) || model;
        const confirmedLabel = confirmed.name || confirmed.id;
        const status = `当前使用 ${confirmedLabel} 模型`;
        setModel(confirmed);
        setConfirmedModelId(created.model);
        setModelStatus(status);
        setConversationSnapshots((items) => ({
          ...items,
          [persistedKey]: {
            ...(items[persistedKey] || { messages: [...messages, userMessage] }),
            messages: items[persistedKey]?.messages || [...messages, userMessage],
            remoteSessionId: sessionIdRef.current,
            model: confirmed,
            confirmedModelId: created.model,
            modelStatus: status,
          },
        }));
      }
      await agentApi.streamMessage(sessionIdRef.current, text, (event) => {
        if (["message", "message.delta", "delta"].includes(event.event)) {
          appendStreamText(agentApi.extractText(event), event.event, event.data.mode);
        }
        if (event.event === "tool_start" || event.event === "tool_end") {
          const toolMessage = toolMessageFromEvent(event.event, event.data, turnId);
          if (toolMessage) setMessages((items) => [...items, toolMessage]);
        }
        if (event.event === "final" && !receivedTextRef.current) appendStreamText(agentApi.extractText(event), event.event);
        if (event.event === "error") {
          appendStreamText(String(event.data.message || "Agent 处理失败，请稍后重试。"), event.event);
        }
      }, apiBaseUrl);
    } catch {
      if (!receivedTextRef.current) {
        appendStreamText("暂时无法连接 Agent 服务，请检查服务状态后重试。");
      }
    } finally {
      setIsStreaming(false);
      setIsStopping(false);
    }
  };

  const stopGeneration = async () => {
    if (!isStreaming || !sessionIdRef.current || isStopping) return;
    setIsStopping(true);
    try {
      await agentApi.interruptSession(sessionIdRef.current, apiBaseUrl);
    } catch {
      setIsStopping(false);
    }
  };

  const canSend = Boolean(model) && !isSwitchingModel;

  const chooseModel = async (nextModel: LlmModel) => {
    setPicker(null);
    if (model?.id === nextModel.id || isStreaming || isSwitchingModel) return;
    const previousModel = model;
    const previousConfirmedModelId = confirmedModelId;
    const previousLabel = previousModel?.name || previousModel?.id || "原模型";
    const nextLabel = nextModel.name || nextModel.id;

    if (!sessionIdRef.current) {
      setModel(nextModel);
      setConfirmedModelId("");
      setModelStatus(`已选择 ${nextLabel} 模型，将用于本对话`);
      return;
    }

    setIsSwitchingModel(true);
    setModelStatus(`正在切换至 ${nextLabel} 模型…`);
    try {
      const switched = await agentApi.switchModel(
        sessionIdRef.current,
        nextModel.id,
        apiBaseUrl,
      );
      const confirmed = models.find((item) => item.id === switched.model) || nextModel;
      const confirmedLabel = confirmed.name || confirmed.id;
      const status = switched.contextInherited
        ? `当前已切换至 ${confirmedLabel} 模型，上下文已继承`
        : `当前已切换至 ${confirmedLabel} 模型`;
      setModel(confirmed);
      setConfirmedModelId(switched.model);
      setModelStatus(status);
      setConversationSnapshots((items) => ({
        ...items,
        [activeConversationKey]: {
          ...(items[activeConversationKey] || { messages }),
          messages: items[activeConversationKey]?.messages || messages,
          remoteSessionId: sessionIdRef.current,
          model: confirmed,
          confirmedModelId: switched.model,
          modelStatus: status,
          projectName: activeProject.name,
        },
      }));
    } catch {
      setModel(previousModel);
      setConfirmedModelId(previousConfirmedModelId);
      setModelStatus(`切换失败，仍在使用 ${previousLabel} 模型`);
    } finally {
      setIsSwitchingModel(false);
    }
  };

  const resetConversation = () => {
    const nextSessionId = `new:${activeProject.app_id}:${Date.now()}`;
    const nextConversationKey = `${activeProject.app_id}:${nextSessionId}`;
    const currentRemoteSessionId = sessionIdRef.current;
    setConversationSnapshots((items) => {
      const next = { ...items };
      const discardUnusedTemporary = activeSession.startsWith("new:")
        && !currentRemoteSessionId
        && messages.length === 0;
      if (discardUnusedTemporary) delete next[activeConversationKey];
      else {
        next[activeConversationKey] = {
          ...(items[activeConversationKey] || {}),
          messages,
          remoteSessionId: currentRemoteSessionId || undefined,
          model,
          confirmedModelId: confirmedModelId || undefined,
          modelStatus: modelStatus || undefined,
          projectName: activeProject.name,
          createdAt: items[activeConversationKey]?.createdAt || Date.now(),
          updatedAt: items[activeConversationKey]?.updatedAt,
        };
      }
      next[nextConversationKey] = {
        messages: [],
        projectName: activeProject.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return next;
    });
    sessionIdRef.current = "";
    setConfirmedModelId("");
    setModelStatus("");
    receivedTextRef.current = "";
    assistantMessageIdRef.current = "";
    setActiveSession(nextSessionId);
    setMessages([]);
    setMessage("");
    setShowArtifacts(false);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("app_id", activeProject.app_id);
    nextUrl.searchParams.set("project_name", activeProject.name);
    nextUrl.searchParams.set("session_id", nextSessionId);
    window.history.replaceState(null, "", nextUrl);
  };

  const activateEmptyProject = (project: WorkspaceProject) => {
    const now = Date.now();
    const nextSessionId = `new:${project.app_id}:${now}`;
    const nextConversationKey = `${project.app_id}:${nextSessionId}`;
    setActiveProject({ app_id: project.app_id, name: project.name });
    setExpandedProjects((value) => ({ ...value, [project.app_id]: true }));
    setConversationSnapshots((items) => ({
      ...items,
      [nextConversationKey]: {
        messages: [],
        projectName: project.name,
        createdAt: now,
        updatedAt: now,
      },
    }));
    setActiveSession(nextSessionId);
    setMessages([]);
    setMessage("");
    sessionIdRef.current = "";
    setConfirmedModelId("");
    setModelStatus("");
    receivedTextRef.current = "";
    assistantMessageIdRef.current = "";
    setShowArtifacts(false);
    onProjectChange?.(project);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("app_id", project.app_id);
    nextUrl.searchParams.set("project_name", project.name);
    nextUrl.searchParams.set("session_id", nextSessionId);
    window.history.replaceState(null, "", nextUrl);
  };

  const chooseSession = (session: WorkspaceSession) => {
    setConversationSnapshots((items) => ({
      ...items,
      [activeConversationKey]: {
        ...(items[activeConversationKey] || {}),
        messages,
        remoteSessionId: sessionIdRef.current || undefined,
        model,
        confirmedModelId: confirmedModelId || undefined,
        modelStatus: modelStatus || undefined,
        projectName: activeProject.name,
        createdAt: items[activeConversationKey]?.createdAt || Date.now(),
        updatedAt: items[activeConversationKey]?.updatedAt,
      },
    }));
    const project = workspaceProjects.find((item) => item.app_id === session.app_id) || {
      app_id: session.app_id,
      name: session.project_name,
      sessions: [session],
    };
    const nextConversationKey = `${project.app_id}:${session.session_id}`;
    const saved = conversationSnapshots[nextConversationKey];
    setActiveProject({ app_id: project.app_id, name: project.name });
    setExpandedProjects((value) => ({ ...value, [project.app_id]: true }));
    setActiveSession(session.session_id);
    setMessages(saved?.messages || [
      { id: `${session.session_id}-user`, role: "user", content: session.user_message || session.title },
      { id: `${session.session_id}-assistant`, role: "assistant", content: session.agent_message || "已恢复该会话，可以继续输入处理要求。" },
    ]);
    setMessage("");
    sessionIdRef.current = saved?.remoteSessionId || "";
    setConfirmedModelId(saved?.confirmedModelId || "");
    setModelStatus(saved?.modelStatus || "");
    receivedTextRef.current = "";
    if (saved?.model) setModel(saved.model);
    setShowArtifacts(false);
    onProjectChange?.(project);
    onSelectSession?.(session);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("app_id", project.app_id);
    nextUrl.searchParams.set("project_name", project.name);
    nextUrl.searchParams.set("session_id", session.session_id);
    window.history.replaceState(null, "", nextUrl);
  };

  const createLocalProject = () => {
    const name = newProjectName.trim();
    if (!name) return;
    const now = Date.now();
    const localAppId = `local_${now}`;
    const nextSessionId = `new:${localAppId}:${now}`;
    const nextConversationKey = `${localAppId}:${nextSessionId}`;
    setConversationSnapshots((items) => ({
      ...items,
      [nextConversationKey]: {
        messages: [],
        projectName: name,
        createdAt: now,
        updatedAt: now,
      },
    }));
    setActiveProject({ app_id: localAppId, name });
    setExpandedProjects((value) => ({ ...value, [localAppId]: true }));
    setActiveSession(nextSessionId);
    setMessages([]);
    setMessage("");
    sessionIdRef.current = "";
    setConfirmedModelId("");
    setModelStatus("");
    receivedTextRef.current = "";
    assistantMessageIdRef.current = "";
    setShowArtifacts(false);
    setNewProjectName("");
    setWorkspacePanel(null);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("app_id", localAppId);
    nextUrl.searchParams.set("project_name", name);
    nextUrl.searchParams.set("session_id", nextSessionId);
    window.history.replaceState(null, "", nextUrl);
  };

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const visibleProjects = workspaceProjects
    .filter((project) => showOtherProjects || project.app_id === activeProject.app_id)
    .map((project, index) => {
      const availableSessions = index === 0 && !showAllSessions ? project.sessions.slice(0, 3) : project.sessions;
      const matchingSessions = availableSessions.filter((session) => !normalizedQuery || session.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
      return { ...project, sessions: matchingSessions, totalSessionCount: project.sessions.length };
    })
    .filter((project) => !normalizedQuery || project.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery) || project.sessions.length);

  return (
    <div className={`app-shell ${sidebarOpen ? "with-sidebar" : "sidebar-collapsed"}`}>
      <aside className="sidebar" aria-label="会话侧栏">
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.2} /></div>
          <div className="brand-copy"><strong>Data Juicer</strong><span>Agent Workspace</span></div>
          <button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧栏"><PanelLeftClose size={19} /></button>
        </div>

        <button className="new-session" onClick={resetConversation}><MessageSquarePlus size={18} />新会话</button>

        <div className="workspace-toolbar">
          <span>工作区</span>
          <div>
            <button className={workspacePanel === "search" ? "active" : ""} onClick={() => setWorkspacePanel((value) => value === "search" ? null : "search")} aria-label="搜索项目"><Search size={17} /></button>
            <button className={!showOtherProjects ? "active" : ""} onClick={() => setShowOtherProjects((value) => !value)} aria-pressed={!showOtherProjects} aria-label="筛选项目"><SlidersHorizontal size={17} /></button>
            <button className={workspacePanel === "add" ? "active" : ""} onClick={() => setWorkspacePanel((value) => value === "add" ? null : "add")} aria-label="添加项目"><FolderPlus size={18} /></button>
          </div>
        </div>

        {workspacePanel === "search" && (
          <div className="workspace-popover search-popover">
            <Search size={15} />
            <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索项目或会话" aria-label="搜索项目或会话" />
            {searchQuery && <button onClick={() => setSearchQuery("")} aria-label="清空搜索"><X size={14} /></button>}
          </div>
        )}
        {workspacePanel === "add" && (
          <form className="workspace-popover add-project-popover" onSubmit={(event) => { event.preventDefault(); createLocalProject(); }}>
            <strong>添加项目</strong>
            <span>项目仅保存在当前工作区，可自定义名称。</span>
            <input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="输入项目名称" aria-label="项目名称" />
            <div className="add-project-actions">
              <button type="button" onClick={() => { setNewProjectName(""); setWorkspacePanel(null); }}>取消</button>
              <button type="submit" className="primary" disabled={!newProjectName.trim()}>创建</button>
            </div>
          </form>
        )}

        <div className="project-tree grow">
          {visibleProjects.map((project, projectIndex) => {
            const expanded = expandedProjects[project.app_id] !== false;
            const isActiveProject = activeProject.app_id === project.app_id;
            return <div className="project-group" key={project.app_id}>
              <button
                className={`project-node ${projectIndex ? "secondary-project" : ""} ${isActiveProject ? "active-project" : ""}`}
                onClick={() => {
                  if (!isActiveProject) {
                    if (project.sessions[0]) chooseSession(project.sessions[0]);
                    else activateEmptyProject(project);
                    return;
                  }
                  setExpandedProjects((value) => ({ ...value, [project.app_id]: !expanded }));
                }}
                aria-expanded={expanded}
                title={`${project.name} · ${project.app_id}`}
              >
                <Folder size={18} />
                <strong>{project.name}</strong>
                <ChevronDown size={15} className={expanded ? "" : "collapsed"} />
              </button>
              {expanded && <nav className={`project-session-list ${projectIndex ? "secondary" : ""}`}>
                {project.sessions.map((session) => (
                  <button
                    key={session.session_id}
                    className={isActiveWorkspaceSession(activeProject.app_id, activeSession, session) ? "active" : ""}
                    onClick={() => chooseSession(session)}
                  >
                    <span>{session.title}</span>
                  </button>
                ))}
                {projectIndex === 0 && project.totalSessionCount > 3 && !normalizedQuery && <button className="expand-sessions" onClick={() => setShowAllSessions((value) => !value)}><span>{showAllSessions ? "收起历史会话" : `展开其余 ${project.totalSessionCount - 3} 个会话`}</span></button>}
              </nav>}
            </div>;
          })}
          {normalizedQuery && !visibleProjects.length && <div className="sidebar-empty">没有匹配的项目或会话</div>}
        </div>
      </aside>

      <main className="main-surface">
        <header className="topbar">
          {!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="展开侧栏"><PanelLeftOpen size={20} /></button>}
          <div className="crumb"><span>数据平台</span><b>/</b><strong>{activeProject.name}</strong></div>
          <div className="topbar-actions">
            <button className="quiet-button" onClick={() => setShowArtifacts((value) => !value)}><Archive size={16} />{showArtifacts ? "返回会话" : "项目输出"}</button>
            {onExit && <button className="quiet-button" onClick={onExit}>返回项目</button>}
            <div className="avatar-wrap">
              <button className="avatar" onClick={() => setUserMenuOpen((value) => !value)} aria-expanded={userMenuOpen} aria-label="用户菜单">{(username || "U").slice(0, 2).toUpperCase()}</button>
              {userMenuOpen && <div className="user-menu"><strong>{username || "当前用户"}</strong><span>{activeProject.name}</span><small>{activeProject.app_id}</small>{onExit && <button onClick={onExit}>返回数据平台</button>}{onLogout && <button onClick={onLogout}>退出登录</button>}</div>}
            </div>
          </div>
        </header>

        {showArtifacts ? (
          <ArtifactLibrary appId={activeProject.app_id} projectName={activeProject.name} apiBaseUrl={apiBaseUrl} onClose={() => setShowArtifacts(false)} />
        ) : <section className={`workspace ${messages.length ? "conversation" : ""}`}>
          {!messages.length ? (
            <div className="welcome">
              <div className="agent-orb"><Bot size={28} /></div>
              <h1>今天想怎样处理数据？</h1>
              <p>直接用自然语言描述清洗、分析或加工需求。</p>
            </div>
          ) : (
            <div className="conversation-view">
              {turns.map((turn) => (
                <div className="chat-turn" key={`${activeConversationKey}:${turn.id}`}>
                  {turn.user && <div className="user-message">{turn.user.content}</div>}
                  <ToolTrace calls={turn.tools} running={isStreaming && turn.id === activeTurnIdRef.current} />
                  {turn.replies.map((item) => (
                    <div className="agent-message" key={item.id}>
                      <span className="thinking-dot" />
                      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content || "正在连接 Agent…"}</ReactMarkdown></div>
                      {isStreaming && item.id === assistantMessageIdRef.current && <span className="stream-caret" aria-hidden="true" />}
                    </div>
                  ))}
                </div>
              ))}
              <div ref={conversationEndRef} />
            </div>
          )}

          <div className="control-stack" ref={pickerRef}>
            {modelStatus && <p className="model-status" role="status">{modelStatus}</p>}
            <div className={`composer ${canSend ? "ready-to-send" : ""}`}>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
                }}
                placeholder={canSend ? "描述你想要的数据处理目标…" : "正在加载可用模型…"}
                disabled={!canSend}
                rows={3}
              />
              <div className="composer-footer">
                <div className="composer-left">
                  <input ref={attachmentRef} className="visually-hidden" type="file" accept=".json,.jsonl,.parquet,.csv,.png,.jpg,.jpeg" onChange={(event) => setAttachmentName(event.target.files?.[0]?.name || "")} />
                  <button className="add-button" onClick={() => attachmentRef.current?.click()} aria-label="添加附件"><Plus size={19} /></button>
                  <button className="model-button" disabled={isStreaming || isSwitchingModel} onClick={() => { const opening = picker !== "model"; setPicker(opening ? "model" : null); if (opening) void refreshModels(); }}>
                    <Sparkles size={15} />{model?.name || model?.id || "选择模型"}<ChevronDown size={14} />
                  </button>
                </div>
                {attachmentName && <span className="selection-caption">附件：{attachmentName}</span>}
                <button className={`send-button ${isStreaming ? "stop" : ""}`} onClick={isStreaming ? stopGeneration : send} disabled={isStreaming ? isStopping : !canSend || !message.trim()} aria-label={isStreaming ? "停止生成" : "发送"}>
                  {isStreaming ? <Square size={15} fill="currentColor" /> : <ArrowUp size={20} />}
                </button>
              </div>

              {picker === "model" && (
                <PickerMenu className="composer-picker-menu" title="切换 LLM" subtitle="由服务端安全发现可用模型" onClose={() => setPicker(null)}>
                  {models.map((item) => (
                    <button className="picker-option" key={item.id} disabled={isSwitchingModel} onClick={() => void chooseModel(item)}>
                      <span className="option-icon"><Sparkles size={18} /></span>
                      <span className="option-copy"><strong>{item.name || item.id}</strong><small>{item.id}</small></span>
                      {model?.id === item.id && <Check size={17} className="selected-model-check" />}
                    </button>
                  ))}
                  {!models.length && <div className="empty-state">模型服务未返回可用模型</div>}
                </PickerMenu>
              )}
            </div>
            <p className="disclaimer">Agent 生成的处理方案在执行前需要你的确认。</p>
          </div>
        </section>}
      </main>
    </div>
  );
}

function PickerMenu({ title, subtitle, onClose, children, className = "" }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`picker-menu ${className}`}>
      <div className="picker-menu-head">
        <div><strong>{title}</strong><span>{subtitle}</span></div>
        <button className="icon-button" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="picker-menu-body">{children}</div>
    </div>
  );
}
