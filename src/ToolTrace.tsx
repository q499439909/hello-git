import { useState } from "react";
import type { ToolCall } from "./lib/chat-events";

function Payload({ title, text }: { title: string; text: string }) {
  const [copyStatus, setCopyStatus] = useState("复制");
  return <details className="trace-payload">
    <summary>{title}</summary>
    <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopyStatus("已复制");
      } catch {
        setCopyStatus("复制失败，请选中文本复制");
      }
    }}>{copyStatus}</button>
    <pre><code>{text || "无内容"}</code></pre>
  </details>;
}

export function ToolTrace({ calls, running }: { calls: ToolCall[]; running: boolean }) {
  if (!calls.length) return null;
  const failed = calls.filter((call) => call.ok === false);
  const pending = calls.filter((call) => call.output === undefined);
  const status = running
    ? (pending.length ? `正在调用 ${pending[0].tool}` : "正在整理回复")
    : (pending.length ? "已结束，部分调用未返回" : "已完成");
  return <details className={`tool-trace ${failed.length ? "has-failure" : ""}`}>
    <summary>
      <span>执行过程 · 调用了 {calls.length} 次工具</span>
      <span className="trace-status">{status}{failed.length > 0 && ` · ${failed.length} 次失败`}</span>
      {failed.length > 0 && <span className="trace-error">{(failed[0].summary || `${failed[0].tool} 调用失败`).slice(0, 140)}</span>}
    </summary>
    <ol className="trace-list">
      {calls.map((call) => <li key={call.callId} className={call.ok === false ? "failed" : ""}>
        <div className="trace-heading"><strong>{call.tool}</strong><span>{call.output === undefined ? (running ? "执行中" : "未返回结果") : (call.ok === false ? "失败" : "完成")}</span></div>
        {call.summary && <p className="trace-summary">{call.summary.slice(0, 180)}</p>}
        {call.input !== undefined && <Payload title="输入参数" text={call.input} />}
        {call.output !== undefined && <Payload title="返回结果" text={call.output} />}
      </li>)}
    </ol>
  </details>;
}
