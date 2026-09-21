import { afterEach, describe, expect, it, vi } from "vitest";

import { agentApi } from "./agent-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent session model contract", () => {
  it("returns the backend-confirmed model when creating a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: "session-1",
      run_id: "run-1",
      model: "model-a",
      switch_revision: 0,
      status: "idle",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(agentApi.createSession({ appId: "app", model: "model-a" })).resolves.toEqual({
      sessionId: "session-1",
      runId: "run-1",
      model: "model-a",
      switchRevision: 0,
      status: "idle",
    });
  });

  it("switches the existing session and reads its confirmed status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session_id: "session-1",
        run_id: "run-1",
        previous_model: "model-a",
        model: "model-b",
        context_inherited: true,
        switch_revision: 1,
        status: "idle",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session_id: "session-1",
        run_id: "run-1",
        model: "model-b",
        switch_revision: 1,
        status: "idle",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const switched = await agentApi.switchModel("session-1", "model-b");
    expect(switched.model).toBe("model-b");
    expect(switched.contextInherited).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent/sessions/session-1/model");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });

    const status = await agentApi.getSession("session-1");
    expect(status.model).toBe("model-b");
    expect(status.switchRevision).toBe(1);
  });
});
