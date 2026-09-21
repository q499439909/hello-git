import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolTrace } from "./ToolTrace";

describe("ToolTrace", () => {
  it("defaults both the process and payload details to collapsed", () => {
    const html = renderToStaticMarkup(<ToolTrace running={false} calls={[
      { callId: "c", tool: "inspect_dataset", input: "{}", output: "result", ok: true },
    ]} />);
    expect(html.match(/<details\b/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(html).toContain("已完成");
    expect(html).toContain("输入参数");
    expect(html).toContain("返回结果");
  });

  it("shows failures in the collapsed summary and does not mark unfinished calls as complete", () => {
    const html = renderToStaticMarkup(<ToolTrace running={false} calls={[
      { callId: "a", tool: "inspect", output: "bad path", summary: "bad path", ok: false },
      { callId: "b", tool: "run", input: "{}" },
    ]} />);
    const summary = html.slice(0, html.indexOf("</summary>"));
    expect(summary).toContain("1 次失败");
    expect(summary).toContain("bad path");
    expect(summary).toContain("部分调用未返回");
  });
});
