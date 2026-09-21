import { describe, expect, it } from "vitest";
import { groupChatTurns, mergeStreamText, toolMessageFromEvent } from "./chat-events";

describe("mergeStreamText", () => {
  it("preserves repeated text and shared prefixes in explicit backend deltas", () => {
    expect(mergeStreamText("same", "same", "message.delta", "append")).toBe("samesame");
    expect(mergeStreamText("same", "same text", "message.delta", "append")).toBe("samesame text");
  });

  it("appends multiple message deltas without repeating snapshots", () => {
    const text = ["当前", "进展", "## 当前", "进展", "总结"].reduce(
      (current, delta) => mergeStreamText(current, delta, "message.delta", "append"), "",
    );
    expect(text).toBe("当前进展## 当前进展总结");
  });

  it("replaces a cumulative snapshot instead of appending it again", () => {
    expect(mergeStreamText("看起来", "看起来是一个图片目录", "message.delta"))
      .toBe("看起来是一个图片目录");
  });

  it("appends genuine delta chunks", () => {
    expect(mergeStreamText("目录下共有", " 10 个文件", "message.delta"))
      .toBe("目录下共有 10 个文件");
  });
});

describe("toolMessageFromEvent", () => {
  it("creates separate call and output records", () => {
    const call = toolMessageFromEvent("tool_start", {
      tool: "execute_bash",
      call_id: "tool_1",
      args: { command: "dir /b" },
    });
    const output = toolMessageFromEvent("tool_end", {
      tool: "execute_bash",
      call_id: "tool_1",
      ok: true,
      summary: "command succeeded",
      result_preview: "{\"stdout\":\"10\"}",
    });

    expect(call).toMatchObject({ role: "tool", toolEvent: { kind: "call", tool: "execute_bash" } });
    expect(output).toMatchObject({ role: "tool", toolEvent: { kind: "output", tool: "execute_bash", ok: true } });
    expect(call?.content).toContain("dir /b");
    expect(output?.content).toContain("stdout");
  });
});

describe("groupChatTurns", () => {
  it("pairs calls and results after reply text and isolates reused call IDs across turns", () => {
    const turns = groupChatTurns([
      { id: "u1", turnId: "t1", role: "user", content: "inspect" },
      { id: "a1", turnId: "t1", role: "assistant", content: "reply" },
      toolMessageFromEvent("tool_start", { call_id: "c", tool: "inspect", args: { n: 10 } }, "t1")!,
      toolMessageFromEvent("tool_end", { call_id: "c", tool: "inspect", summary: "done", ok: true }, "t1")!,
      { id: "u2", turnId: "t2", role: "user", content: "again" },
      toolMessageFromEvent("tool_start", { call_id: "c", tool: "inspect" }, "t2")!,
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].replies[0].content).toBe("reply");
    expect(turns[0].tools).toHaveLength(1);
    expect(turns[0].tools[0]).toMatchObject({ callId: "c", ok: true, summary: "done" });
    expect(turns[0].tools[0].input).toContain('"n": 10');
    expect(turns[1].tools[0].output).toBeUndefined();
  });

  it("groups legacy history and pairs out-of-order results without duplicating calls", () => {
    const output = toolMessageFromEvent("tool_end", { call_id: "c", tool: "inspect", ok: false, summary: "bad path" })!;
    const turns = groupChatTurns([
      { id: "u", role: "user", content: "inspect" },
      output,
      toolMessageFromEvent("tool_start", { call_id: "c", tool: "inspect", args: "path" })!,
      output,
      { id: "a", role: "assistant", content: "failed" },
      { id: "u2", role: "user", content: "next" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].tools).toEqual([{ callId: "c", tool: "inspect", input: "path", output: "bad path", summary: "bad path", ok: false }]);
    expect(turns[1].tools).toEqual([]);
  });
});
