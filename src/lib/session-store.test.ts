import { describe, expect, it } from "vitest";
import {
  isActiveWorkspaceSession,
  mergeSnapshotSessions,
  promoteConversationSnapshot,
  selectPersistedSession,
} from "./session-store";

describe("isActiveWorkspaceSession", () => {
  it("does not highlight matching session ids from another project", () => {
    expect(isActiveWorkspaceSession(
      "app_1",
      "session_shared",
      { app_id: "app_1", session_id: "session_shared" },
    )).toBe(true);
    expect(isActiveWorkspaceSession(
      "app_1",
      "session_shared",
      { app_id: "app_2", session_id: "session_shared" },
    )).toBe(false);
  });
});

describe("selectPersistedSession", () => {
  const sessions = [
    { session_id: "session_app_demo", app_id: "app_demo", project_name: "Demo", title: "已有会话" },
  ];

  it("keeps a requested new conversation instead of falling back to another project", () => {
    expect(selectPersistedSession(sessions, "new:local_a:123", "local_a")).toBeUndefined();
  });

  it("restores an explicitly requested persisted conversation", () => {
    expect(selectPersistedSession(sessions, "session_app_demo", "local_a")?.session_id)
      .toBe("session_app_demo");
  });
});

describe("mergeSnapshotSessions", () => {
  it("replaces a temporary conversation with its persisted session", () => {
    const temporaryKey = "app_1:new:app_1:123";
    const persistedKey = "app_1:session_created";
    const snapshots = {
      [temporaryKey]: {
        messages: [
          { id: "u1", role: "user" as const, content: "检查数据" },
          { id: "a1", role: "assistant" as const, content: "完整回复" },
        ],
        projectName: "项目一",
        createdAt: 123,
      },
    };

    const promoted = promoteConversationSnapshot(
      snapshots,
      temporaryKey,
      persistedKey,
      { remoteSessionId: "session_created" },
    );
    const projects = mergeSnapshotSessions([{
      app_id: "app_1",
      name: "项目一",
      sessions: [{
        session_id: "session_created",
        app_id: "app_1",
        project_name: "项目一",
        title: "检查数据",
      }],
    }], promoted);

    expect(promoted[temporaryKey]).toBeUndefined();
    expect(promoted[persistedKey].messages.at(-1)?.content).toBe("完整回复");
    expect(projects[0].sessions.map((item) => item.session_id)).toEqual(["session_created"]);
  });

  it("keeps a newly created conversation reachable after switching sessions", () => {
    const projects = [{
      app_id: "app_1",
      name: "项目一",
      sessions: [{
        session_id: "session_existing",
        app_id: "app_1",
        project_name: "项目一",
        title: "已有会话",
      }],
    }];
    const snapshots = {
      "app_1:new:app_1:123": {
        messages: [
          { id: "u1", role: "user" as const, content: "检查新数据集里的重复样本" },
          { id: "a1", role: "assistant" as const, content: "开始检查" },
        ],
        projectName: "项目一",
        createdAt: 123,
      },
    };

    const result = mergeSnapshotSessions(projects, snapshots);

    expect(result[0].sessions.map((item) => item.session_id)).toEqual([
      "new:app_1:123",
      "session_existing",
    ]);
    expect(result[0].sessions[0].title).toBe("检查新数据集里的重复样本");
  });

  it("orders new and newly active conversations at the top of their project", () => {
    const projects = [{
      app_id: "app_1",
      name: "项目一",
      sessions: [
        {
          session_id: "session_first",
          app_id: "app_1",
          project_name: "项目一",
          title: "原第一条会话",
        },
        {
          session_id: "session_active_again",
          app_id: "app_1",
          project_name: "项目一",
          title: "重新交互的旧会话",
        },
      ],
    }];
    const snapshots = {
      "app_1:session_first": {
        messages: [],
        projectName: "项目一",
        createdAt: 900,
      },
      "app_1:session_active_again": {
        messages: [{ id: "u1", role: "user" as const, content: "继续处理" }],
        projectName: "项目一",
        createdAt: 100,
        updatedAt: 1_100,
      },
      "app_1:new:app_1:1000": {
        messages: [],
        projectName: "项目一",
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    };

    const result = mergeSnapshotSessions(projects, snapshots);

    expect(result[0].sessions.map((item) => item.session_id)).toEqual([
      "session_active_again",
      "new:app_1:1000",
      "session_first",
    ]);
  });
});
