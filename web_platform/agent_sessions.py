"""User-scoped, durable web sessions backed by DJSessionAgent."""

from __future__ import annotations

import json
import queue
import threading
from dataclasses import dataclass, field
from typing import Any, Iterator
from uuid import uuid4

from .catalog import LOCAL_USER_ID
from .service import ArtifactPlatform, RunLayout


class SessionBusyError(RuntimeError):
    """Raised when a mutable session operation races with an active turn."""


@dataclass
class WebAgentSession:
    session_id: str
    app_id: str
    agent: Any
    layout: RunLayout
    platform: ArtifactPlatform
    model_id: str = ""
    switch_revision: int = 0
    active_events: queue.Queue | None = None
    finalize_after_turn: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)
    user_id: str = LOCAL_USER_ID
    persisted: bool = False

    def on_agent_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", "tool.event"))
        if (
            event_type == "tool_end"
            and event.get("tool") in {"apply_recipe", "submit_ray_job"}
            and bool(event.get("ok", True))
        ):
            self.finalize_after_turn = True
        if self.persisted and event_type in {"tool_start", "tool_end"}:
            self.platform.catalog.append_message(
                self.user_id,
                self.session_id,
                f"msg_{uuid4().hex}",
                "tool",
                event,
                event_type,
            )
        if self.active_events is not None:
            self.active_events.put((event_type, event))

    @staticmethod
    def _message_text(message: Any) -> str:
        content = getattr(message, "content", "")
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return str(content or "")
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif hasattr(block, "text"):
                parts.append(str(getattr(block, "text", "")))
        return "".join(parts)

    def interrupt(self) -> bool:
        return bool(self.agent.request_interrupt())

    def describe(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "app_id": self.app_id,
            "run_id": self.layout.run_id,
            "model": self.model_id,
            "switch_revision": self.switch_revision,
            "status": "busy" if self.lock.locked() else "idle",
        }

    def switch_model(self, model_id: str) -> dict[str, Any]:
        target = str(model_id or "").strip()
        if not target:
            raise ValueError("model is required")
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError("cannot switch model while a turn is running")
        previous = self.model_id
        try:
            effective = str(self.agent.switch_model(target)).strip()
            if not effective:
                raise RuntimeError("agent did not report the effective model")
            self.model_id = effective
            if effective != previous:
                self.switch_revision += 1
            self._persist_state()
            return {
                "session_id": self.session_id,
                "run_id": self.layout.run_id,
                "previous_model": previous,
                "model": self.model_id,
                "context_inherited": True,
                "switch_revision": self.switch_revision,
                "status": "idle",
            }
        finally:
            self.lock.release()

    def stream_turn(self, message: str) -> Iterator[str]:
        if not self.lock.acquire(blocking=False):
            yield self._sse("error", {"message": "当前会话已有任务正在运行"})
            return
        events: queue.Queue = queue.Queue()
        self.active_events = events
        self.finalize_after_turn = False
        if self.persisted:
            existing = self.platform.catalog.list_messages(
                self.user_id, self.session_id
            )
            self.platform.catalog.append_message(
                self.user_id, self.session_id, f"msg_{uuid4().hex}", "user", message
            )
            if not existing:
                self.platform.catalog.update_agent_session(
                    self.user_id, self.session_id, title=message.strip()[:80]
                )

        def worker() -> None:
            message_texts: dict[str, str] = {}
            anonymous_text = ""

            def emit_chunk(chunk: Any, last: bool) -> None:
                nonlocal anonymous_text
                message_id = str(getattr(chunk, "id", "") or "")
                streamed_text = (
                    message_texts.get(message_id, "") if message_id else anonymous_text
                )
                text = self._message_text(chunk)
                if not text:
                    if last and not message_id:
                        anonymous_text = ""
                    return
                if text.startswith(streamed_text):
                    delta = text[len(streamed_text) :]
                    streamed_text = text
                else:
                    delta = text
                    streamed_text += text
                if message_id:
                    message_texts[message_id] = streamed_text
                else:
                    anonymous_text = "" if last else streamed_text
                if delta:
                    events.put(
                        (
                            "message.delta",
                            {
                                "delta": delta,
                                "last": bool(last),
                                "mode": "append",
                            },
                        )
                    )

            try:
                reply = self.agent.handle_message_stream(message, emit_chunk)
                if self.finalize_after_turn:
                    committed = self.platform.finalize_run(
                        self.layout.run_id, user_id=self.user_id
                    )
                    events.put(
                        (
                            "artifacts.committed",
                            {
                                "run_id": self.layout.run_id,
                                "artifact_count": len(committed.get("artifacts", [])),
                            },
                        )
                    )
                    self.layout = self.platform.begin_run(
                        self.app_id, user_id=self.user_id, session_id=self.session_id
                    )
                    self.agent.state.working_dir = str(self.layout.working_dir)
                    self.agent.state.export_path = None
                if self.persisted:
                    self.platform.catalog.append_message(
                        self.user_id,
                        self.session_id,
                        f"msg_{uuid4().hex}",
                        "assistant",
                        reply.text,
                        (
                            "interrupted"
                            if bool(getattr(reply, "interrupted", False))
                            else "text"
                        ),
                    )
                    self._persist_state()
                events.put(
                    (
                        "final",
                        {
                            "text": reply.text,
                            "stop": reply.stop,
                            "interrupted": bool(getattr(reply, "interrupted", False)),
                        },
                    )
                )
            except Exception as exc:
                if self.persisted:
                    self.platform.catalog.append_message(
                        self.user_id,
                        self.session_id,
                        f"msg_{uuid4().hex}",
                        "assistant",
                        str(exc),
                        "error",
                    )
                    self._persist_state()
                events.put(("error", {"message": str(exc)}))
            finally:
                events.put(("done", {}))

        threading.Thread(
            target=worker, name=f"dj-web-{self.session_id}", daemon=True
        ).start()
        try:
            while True:
                event, data = events.get()
                yield self._sse(event, data)
                if event == "done":
                    yield "data: [DONE]\n\n"
                    break
        finally:
            self.active_events = None
            self.lock.release()

    def _persist_state(self) -> None:
        if not self.persisted:
            return
        exporter = getattr(self.agent, "export_persistent_state", None)
        state = exporter() if callable(exporter) else {}
        self.platform.catalog.update_agent_session(
            self.user_id, self.session_id, model=self.model_id, state=state
        )

    @staticmethod
    def _sse(event: str, data: dict[str, Any]) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


class AgentSessionRegistry:
    """Lazily materializes durable sessions into in-memory Agent instances."""

    def __init__(self, platform: ArtifactPlatform) -> None:
        self.platform = platform
        self._sessions: dict[tuple[str, str], WebAgentSession] = {}
        self._lock = threading.Lock()

    def create(
        self,
        *,
        app_id: str,
        model: str | None = None,
        user_id: str = LOCAL_USER_ID,
    ) -> WebAgentSession:
        session_id = f"session_{uuid4().hex[:12]}"
        session = self._materialize(
            user_id=user_id,
            session_id=session_id,
            app_id=app_id,
            model=model,
            state=None,
            create_record=True,
        )
        return session

    def get(self, session_id: str, *, user_id: str = LOCAL_USER_ID) -> WebAgentSession:
        key = (user_id, session_id)
        with self._lock:
            session = self._sessions.get(key)
        if session is not None:
            return session
        record = self.platform.catalog.get_agent_session(user_id, session_id)
        if record is None:
            raise KeyError(f"unknown agent session: {session_id}")
        return self._materialize(
            user_id=user_id,
            session_id=session_id,
            app_id=record["app_id"],
            model=record.get("model") or None,
            state=record.get("state"),
            create_record=False,
        )

    def list(self, user_id: str) -> list[dict[str, Any]]:
        return self.platform.catalog.list_agent_sessions(user_id)

    def messages(self, user_id: str, session_id: str) -> list[dict[str, Any]]:
        if self.platform.catalog.get_agent_session(user_id, session_id) is None:
            raise KeyError(f"unknown agent session: {session_id}")
        return self.platform.catalog.list_messages(user_id, session_id)

    def _materialize(
        self,
        *,
        user_id: str,
        session_id: str,
        app_id: str,
        model: str | None,
        state: dict[str, Any] | None,
        create_record: bool,
    ) -> WebAgentSession:
        from data_juicer_agents.capabilities.session.orchestrator import DJSessionAgent

        layout = self.platform.begin_run(app_id, user_id=user_id, session_id=session_id)
        holder: dict[str, WebAgentSession] = {}

        def event_callback(event: dict[str, Any]) -> None:
            session = holder.get("session")
            if session is not None:
                session.on_agent_event(event)

        def resolve_export(path, export_type=None):
            current = holder["session"].layout if "session" in holder else layout
            return str(current.export_file(path, export_type))

        class WebSessionAgent(DJSessionAgent):
            def _build_toolkit(self):
                from .tool_binding import build_web_toolkit

                return build_web_toolkit(self._tool_runtime, resolve_export)

        agent = WebSessionAgent(
            use_llm_router=True,
            dataset_path=None,
            export_path=None,
            working_dir=str(layout.working_dir),
            model_name=model,
            event_callback=event_callback,
            enable_streaming=True,
        )
        loader = getattr(agent, "load_persistent_state", None)
        if state and callable(loader):
            loader(state)
        session = WebAgentSession(
            session_id,
            app_id,
            agent,
            layout,
            self.platform,
            model_id=str(agent.current_model_name),
            user_id=user_id,
            persisted=True,
        )
        holder["session"] = session
        if create_record:
            self.platform.catalog.create_agent_session(
                session_id, user_id, app_id, session.model_id
            )
        with self._lock:
            existing = self._sessions.setdefault((user_id, session_id), session)
        return existing
