"""FastAPI surface for the portable artifact platform."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .auth import AccountConflictError, AuthManager, AuthenticationError
from .service import ArtifactPlatform
from .settings import PlatformSettings


def create_app(settings: PlatformSettings | None = None):
    try:
        from fastapi import (
            FastAPI,
            HTTPException,
            Query,
            Request as FastAPIRequest,
            Response,
        )
        from fastapi.responses import FileResponse, StreamingResponse
        from fastapi.staticfiles import StaticFiles
    except ImportError as exc:  # pragma: no cover - exercised by the CLI message
        raise RuntimeError("dj-web requires `pip install -e '.[web]'`") from exc

    # Endpoint annotations are postponed by ``from __future__ import annotations``.
    # Publish optional FastAPI types so its dependency resolver can resolve them.
    globals()["FastAPIRequest"] = FastAPIRequest
    globals()["Response"] = Response

    resolved = settings or PlatformSettings.load()
    platform = ArtifactPlatform(resolved)
    platform.initialize()
    auth = AuthManager(platform.catalog, resolved.auth_session_days)
    app = FastAPI(title="Data-Juicer Agent Web", version="0.1.0")
    app.state.artifact_platform = platform
    app.state.auth_manager = auth
    from .agent_sessions import AgentSessionRegistry, SessionBusyError

    sessions = AgentSessionRegistry(platform)
    app.state.agent_sessions = sessions

    def fail(exc: Exception) -> HTTPException:
        if isinstance(exc, AuthenticationError):
            return HTTPException(status_code=401, detail=str(exc))
        if isinstance(exc, AccountConflictError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, SessionBusyError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, KeyError):
            return HTTPException(status_code=404, detail=str(exc))
        if isinstance(exc, FileNotFoundError):
            return HTTPException(status_code=404, detail="artifact file is missing")
        if isinstance(exc, FileExistsError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, (ValueError, RuntimeError)):
            return HTTPException(status_code=400, detail=str(exc))
        return HTTPException(status_code=500, detail="artifact operation failed")

    def current_user(request: FastAPIRequest) -> dict[str, Any]:
        user = auth.authenticate(request.cookies.get(resolved.auth_cookie_name))
        if not user:
            raise HTTPException(status_code=401, detail="authentication required")
        return user

    def set_auth_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            resolved.auth_cookie_name,
            token,
            max_age=resolved.auth_session_days * 24 * 60 * 60,
            httponly=True,
            secure=resolved.auth_cookie_secure,
            samesite="lax",
            path="/",
        )

    @app.get("/api/dj/v1/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "platform_home": str(resolved.home)}

    @app.post("/api/auth/register")
    def register(payload: dict[str, Any], response: Response):
        try:
            user, token = auth.register(
                str(payload.get("username", "")),
                str(payload.get("password", "")),
                str(payload.get("display_name", "")),
            )
            set_auth_cookie(response, token)
            return {"data": user}
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/auth/login")
    def login(payload: dict[str, Any], response: Response):
        try:
            user, token = auth.login(
                str(payload.get("username", "")), str(payload.get("password", ""))
            )
            set_auth_cookie(response, token)
            return {"data": user}
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/auth/logout")
    def logout(request: FastAPIRequest, response: Response):
        auth.logout(request.cookies.get(resolved.auth_cookie_name))
        response.delete_cookie(resolved.auth_cookie_name, path="/")
        return {"ok": True}

    @app.get("/api/auth/me")
    def me(request: FastAPIRequest):
        return {"data": current_user(request)}

    @app.patch("/api/auth/password")
    def change_password(
        payload: dict[str, Any], request: FastAPIRequest, response: Response
    ):
        try:
            user = current_user(request)
            token = auth.change_password(
                user["id"],
                str(payload.get("current_password", "")),
                str(payload.get("new_password", "")),
            )
            set_auth_cookie(response, token)
            return {"ok": True}
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/admin/users")
    def list_users(request: FastAPIRequest):
        user = current_user(request)
        if user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="administrator role required")
        return {"data": {"items": platform.catalog.list_users()}}

    @app.patch("/api/admin/users/{user_id}/status")
    def set_user_status(user_id: str, payload: dict[str, Any], request: FastAPIRequest):
        user = current_user(request)
        if user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="administrator role required")
        status = str(payload.get("status", ""))
        if status not in {"active", "disabled", "deleted"}:
            raise HTTPException(status_code=400, detail="invalid account status")
        updated = platform.catalog.update_user_status(user_id, status)
        if not updated:
            raise HTTPException(status_code=404, detail="unknown user")
        return {"data": updated}

    @app.get("/api/llm/models")
    def list_llm_models(request: FastAPIRequest) -> dict[str, Any]:
        current_user(request)
        base_url = os.environ.get("DJA_OPENAI_BASE_URL", "").rstrip("/")
        api_key = os.environ.get("DASHSCOPE_API_KEY") or os.environ.get(
            "MODELSCOPE_API_TOKEN"
        )
        if not base_url or not api_key:
            raise HTTPException(status_code=503, detail="LLM service is not configured")
        request = Request(
            f"{base_url}/models",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(
                request, timeout=15
            ) as response:  # noqa: S310 - operator configured URL
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            raise HTTPException(
                status_code=502, detail="Unable to discover LLM models"
            ) from exc
        raw_items = (
            payload.get("data", payload.get("items", []))
            if isinstance(payload, dict)
            else []
        )
        items = [
            item for item in raw_items if isinstance(item, dict) and item.get("id")
        ]
        return {
            "data": {
                "items": items,
                "default_model": os.environ.get("DJA_SESSION_MODEL", ""),
            }
        }

    @app.post("/api/agent/sessions")
    def create_agent_session(payload: dict[str, Any], request: FastAPIRequest):
        try:
            user = current_user(request)
            session = sessions.create(
                app_id=str(payload.get("app_id", "")),
                model=str(payload.get("model", "")).strip() or None,
                user_id=user["id"],
            )
            return session.describe()
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/agent/sessions")
    def list_agent_sessions(request: FastAPIRequest):
        user = current_user(request)
        return {"data": {"items": sessions.list(user["id"])}}

    @app.get("/api/agent/sessions/{session_id}")
    def get_agent_session(session_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return sessions.get(session_id, user_id=user["id"]).describe()
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/agent/sessions/{session_id}/messages")
    def get_agent_session_messages(session_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {"data": {"items": sessions.messages(user["id"], session_id)}}
        except Exception as exc:
            raise fail(exc) from exc

    @app.patch("/api/agent/sessions/{session_id}/model")
    def switch_agent_session_model(
        session_id: str, payload: dict[str, Any], request: FastAPIRequest
    ):
        try:
            user = current_user(request)
            return sessions.get(session_id, user_id=user["id"]).switch_model(
                str(payload.get("model", "")).strip()
            )
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/agent/sessions/{session_id}/messages")
    def send_agent_message(
        session_id: str, payload: dict[str, Any], request: FastAPIRequest
    ):
        try:
            user = current_user(request)
            session = sessions.get(session_id, user_id=user["id"])
            message = str(payload.get("message", "")).strip()
            if not message:
                raise ValueError("message is required")
            return StreamingResponse(
                session.stream_turn(message), media_type="text/event-stream"
            )
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/agent/sessions/{session_id}/interrupt")
    def interrupt_agent_message(session_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            accepted = sessions.get(session_id, user_id=user["id"]).interrupt()
            return {"accepted": accepted}
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/dj/v1/projects/{app_id}/initialize")
    def initialize_project(
        app_id: str, request: FastAPIRequest, payload: dict[str, Any] | None = None
    ):
        try:
            user = current_user(request)
            return {
                "data": platform.ensure_project(
                    app_id,
                    str((payload or {}).get("project_name", "")),
                    user_id=user["id"],
                )
            }
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/dj/v1/projects/{app_id}/runs")
    def begin_run(app_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {"data": platform.begin_run(app_id, user_id=user["id"]).to_dict()}
        except Exception as exc:
            raise fail(exc) from exc

    @app.post("/api/dj/v1/runs/{run_id}/finalize")
    def finalize_run(run_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {"data": platform.finalize_run(run_id, user_id=user["id"])}
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/projects/{app_id}/artifacts")
    def list_artifacts(app_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {
                "data": {"items": platform.list_artifacts(app_id, user_id=user["id"])}
            }
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}")
    def get_artifact(artifact_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {"data": platform.get_artifact(artifact_id, user_id=user["id"])}
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}/preview-descriptor")
    def preview_descriptor(artifact_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {
                "data": platform.preview_descriptor(artifact_id, user_id=user["id"])
            }
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}/json")
    def json_preview(artifact_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            return {
                "data": platform.read_json(artifact_id, user_id=user["id"]),
                "truncated": False,
            }
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}/text")
    def text_preview(
        artifact_id: str,
        request: FastAPIRequest,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=65536, ge=1, le=1048576),
    ):
        try:
            user = current_user(request)
            return {
                "data": platform.read_text(
                    artifact_id, offset, limit, user_id=user["id"]
                )
            }
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}/records")
    def records_preview(
        artifact_id: str,
        request: FastAPIRequest,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=200),
    ):
        try:
            user = current_user(request)
            return {
                "data": platform.read_records(
                    artifact_id, offset, limit, user_id=user["id"]
                )
            }
        except Exception as exc:
            raise fail(exc) from exc

    def artifact_file(artifact_id: str, user_id: str, *, download: bool = False):
        try:
            artifact = platform.get_artifact(artifact_id, user_id=user_id)
            path = platform.artifact_path(artifact_id, user_id=user_id)
            return FileResponse(
                path,
                media_type=artifact["mime_type"],
                filename=artifact["name"] if download else None,
                content_disposition_type="attachment" if download else "inline",
            )
        except Exception as exc:
            raise fail(exc) from exc

    @app.get("/api/dj/v1/artifacts/{artifact_id}/content")
    def content(artifact_id: str, request: FastAPIRequest):
        return artifact_file(artifact_id, current_user(request)["id"])

    @app.get("/api/dj/v1/artifacts/{artifact_id}/download")
    def download(artifact_id: str, request: FastAPIRequest):
        return artifact_file(artifact_id, current_user(request)["id"], download=True)

    @app.get("/api/dj/v1/artifacts/{artifact_id}/thumbnail")
    def thumbnail(artifact_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            path = platform.thumbnail_path(artifact_id, user_id=user["id"])
            media_type = "image/webp" if path.suffix.lower() == ".webp" else None
            return FileResponse(path, media_type=media_type)
        except Exception as exc:
            raise fail(exc) from exc

    @app.delete("/api/dj/v1/artifacts/{artifact_id}")
    def delete_artifact(artifact_id: str, request: FastAPIRequest):
        try:
            user = current_user(request)
            platform.delete_artifact(artifact_id, user_id=user["id"])
            return {"ok": True}
        except Exception as exc:
            raise fail(exc) from exc

    static_dir = resolved.static_dir
    if static_dir.exists() and (static_dir / "index.html").exists():
        assets = static_dir / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}")
        def spa(path: str):
            candidate = (static_dir / path).resolve()
            try:
                candidate.relative_to(static_dir.resolve())
            except ValueError:
                candidate = static_dir / "index.html"
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(static_dir / "index.html")

    return app
