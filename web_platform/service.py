"""High-leverage interface for user-scoped run and artifact management."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from .catalog import Catalog, LOCAL_USER_ID
from .settings import PlatformSettings
from .storage import LocalArtifactStore

TEXT_SUFFIXES = {".txt", ".log", ".md", ".yaml", ".yml", ".csv"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
class RunLayout:
    user_id: str
    session_id: str
    run_id: str
    app_id: str
    run_dir: Path
    staging_dir: Path
    working_dir: Path
    plans_dir: Path
    recipes_dir: Path
    output_dir: Path
    records_dir: Path
    media_dir: Path
    reports_dir: Path
    logs_dir: Path

    def export_file(
        self,
        export_path: str | None = None,
        export_type: str | None = None,
    ) -> Path:
        """Relocate a named dataset file into this run without changing its name."""
        supported = {"jsonl", "json", "parquet"}
        explicit_format = str(export_type or "").strip().lower()
        if explicit_format and explicit_format not in supported:
            raise ValueError(f"Unsupported export_type: {export_type}")
        raw = str(export_path or "").strip()
        source = Path(raw)
        if (
            not raw
            or raw.endswith(("/", "\\"))
            or source.is_dir()
            or source.name in {"", ".", "..", "records"}
        ):
            raise ValueError(
                "export_path must include an output filename, not a directory"
            )
        suffix = source.suffix.lstrip(".").lower()
        if not explicit_format and suffix not in supported:
            raise ValueError(
                "export_path needs a .jsonl, .json or .parquet suffix, or an explicit export_type"
            )
        name = source.name
        if explicit_format and suffix != explicit_format:
            name = (
                source.stem if suffix in supported else source.name
            ) + f".{explicit_format}"
        return self.records_dir / name

    def to_dict(self) -> dict[str, str]:
        return {key: str(value) for key, value in self.__dict__.items()}


class ArtifactPlatform:
    """Own the complete user-scoped lifecycle from execution to preview."""

    def __init__(self, settings: PlatformSettings) -> None:
        self.settings = settings
        self.store = LocalArtifactStore(settings.home)
        self.catalog = Catalog(settings.database_path)

    @classmethod
    def open(cls, home: str | Path | None = None) -> "ArtifactPlatform":
        platform = cls(PlatformSettings.load(home))
        platform.initialize()
        return platform

    def initialize(self) -> None:
        self.settings.ensure_directories()
        self.catalog.initialize()
        self.catalog.initialize_wal()

    def ensure_project(
        self, app_id: str, project_name: str = "", *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any]:
        user = self._identifier(user_id, "user_id")
        app = self._identifier(app_id, "app_id")
        self._user_root(user).mkdir(parents=True, exist_ok=True)
        return self.catalog.ensure_project(app, project_name, user_id=user)

    def begin_run(
        self,
        app_id: str,
        run_id: str | None = None,
        *,
        user_id: str = LOCAL_USER_ID,
        session_id: str | None = None,
    ) -> RunLayout:
        user = self._identifier(user_id, "user_id")
        app = self._identifier(app_id, "app_id")
        session = self._identifier(session_id or f"session_{app}", "session_id")
        run = self._identifier(run_id or f"run_{uuid4().hex[:12]}", "run_id")
        self.ensure_project(app, user_id=user)
        run_dir = self._user_root(user) / "sessions" / session / "runs" / run
        if run_dir.exists():
            raise FileExistsError(run_dir)
        layout = RunLayout(
            user_id=user,
            session_id=session,
            run_id=run,
            app_id=app,
            run_dir=run_dir,
            staging_dir=run_dir,
            working_dir=run_dir / ".djx",
            plans_dir=run_dir / "plans",
            recipes_dir=run_dir / "recipes",
            output_dir=run_dir / "outputs",
            records_dir=run_dir / "outputs" / "records",
            media_dir=run_dir / "outputs" / "media" / "images",
            reports_dir=run_dir / "outputs" / "reports",
            logs_dir=run_dir / "logs",
        )
        for path in (
            layout.working_dir,
            layout.plans_dir,
            layout.recipes_dir,
            layout.records_dir,
            layout.media_dir,
            layout.reports_dir,
            layout.logs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        self.catalog.create_run(
            run, app, self.store.key_for(run_dir), user_id=user, session_id=session
        )
        return layout

    def finalize_run(
        self, run_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any]:
        user = self._identifier(user_id, "user_id")
        run = self.catalog.get_run(run_id, user_id=user)
        if not run:
            raise KeyError(f"unknown run: {run_id}")
        if run["status"] == "succeeded":
            return {
                "run": run,
                "artifacts": self.catalog.list_artifacts(run["app_id"], user_id=user),
            }
        run_dir = self.store.resolve(run["staging_key"])
        self._capture_runtime_artifacts(run_dir)
        manifest = self._build_manifest(user, run["app_id"], run_id, run_dir)
        (run_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        artifacts: list[dict[str, Any]] = []
        for item in manifest["artifacts"]:
            payload = dict(item)
            payload["storage_key"] = f"{run['staging_key']}/{item['relative_path']}"
            payload.pop("relative_path", None)
            self.catalog.add_artifact(payload)
            artifacts.append(payload)
        self.catalog.finish_run(run_id, run["staging_key"], user_id=user)
        return {
            "run": self.catalog.get_run(run_id, user_id=user),
            "artifacts": artifacts,
            "manifest": manifest,
        }

    @staticmethod
    def _capture_runtime_artifacts(run_dir: Path) -> None:
        runtime = run_dir / ".djx"
        if not runtime.exists():
            return
        for source in runtime.rglob("*.yaml"):
            if source.is_symlink():
                continue
            target_dir = run_dir / "recipes"
            try:
                import yaml

                payload = yaml.safe_load(source.read_text(encoding="utf-8"))
                if isinstance(payload, dict) and isinstance(
                    payload.get("recipe"), dict
                ):
                    target_dir = run_dir / "plans"
            except (ImportError, OSError, UnicodeError, ValueError):
                pass
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / source.name
            if not target.exists():
                shutil.copy2(source, target)

    def list_artifacts(
        self, app_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> list[dict[str, Any]]:
        return self.catalog.list_artifacts(
            self._identifier(app_id, "app_id"),
            user_id=self._identifier(user_id, "user_id"),
        )

    def get_artifact(
        self, artifact_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any]:
        artifact = self.catalog.get_artifact(
            artifact_id, user_id=self._identifier(user_id, "user_id")
        )
        if not artifact:
            raise KeyError(f"unknown artifact: {artifact_id}")
        return artifact

    def preview_descriptor(
        self, artifact_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any]:
        artifact = self.get_artifact(artifact_id, user_id=user_id)
        viewer = {
            "json": "json",
            "jsonl": "table",
            "parquet": "table",
            "image": "image",
            "text": "text",
        }.get(artifact["kind"], "download-only")
        base = f"/api/dj/v1/artifacts/{artifact_id}"
        descriptor = {
            "artifact_id": artifact_id,
            "viewer": viewer,
            "name": artifact["name"],
            "mime_type": artifact["mime_type"],
            "byte_size": artifact["byte_size"],
            "metadata": artifact["metadata"],
            "download_url": f"{base}/download",
        }
        if viewer == "image":
            descriptor.update(
                content_url=f"{base}/content", thumbnail_url=f"{base}/thumbnail"
            )
        elif viewer == "json":
            descriptor["data_url"] = f"{base}/json"
        elif viewer == "table":
            descriptor["records_url"] = f"{base}/records"
        elif viewer == "text":
            descriptor["text_url"] = f"{base}/text"
        return descriptor

    def read_json(self, artifact_id: str, *, user_id: str = LOCAL_USER_ID) -> Any:
        artifact = self.get_artifact(artifact_id, user_id=user_id)
        if artifact["kind"] != "json":
            raise ValueError("artifact is not a JSON document")
        if artifact["byte_size"] > self.settings.max_inline_json_bytes:
            raise ValueError("JSON document is too large for inline preview")
        return json.loads(
            self.store.resolve(artifact["storage_key"]).read_text(encoding="utf-8")
        )

    def read_text(
        self,
        artifact_id: str,
        offset: int = 0,
        limit: int = 65536,
        *,
        user_id: str = LOCAL_USER_ID,
    ) -> dict[str, Any]:
        artifact = self.get_artifact(artifact_id, user_id=user_id)
        path = self.store.resolve(artifact["storage_key"])
        safe_limit = max(1, min(limit, 1024 * 1024))
        with path.open("rb") as handle:
            handle.seek(max(0, offset))
            chunk = handle.read(safe_limit)
            has_more = bool(handle.read(1))
        return {
            "text": chunk.decode("utf-8", errors="replace"),
            "offset": max(0, offset),
            "limit": safe_limit,
            "has_more": has_more,
        }

    def read_records(
        self,
        artifact_id: str,
        offset: int = 0,
        limit: int = 100,
        *,
        user_id: str = LOCAL_USER_ID,
    ) -> dict[str, Any]:
        artifact = self.get_artifact(artifact_id, user_id=user_id)
        safe_offset = max(0, offset)
        safe_limit = max(1, min(limit, self.settings.preview_row_limit))
        path = self.store.resolve(artifact["storage_key"])
        if artifact["kind"] == "jsonl":
            rows: list[Any] = []
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for index, line in enumerate(handle):
                    if index < safe_offset:
                        continue
                    if len(rows) >= safe_limit + 1:
                        break
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        rows.append({"_raw": line.rstrip("\n")})
            return self._record_payload(rows, safe_offset, safe_limit)
        if artifact["kind"] == "parquet":
            try:
                import duckdb
            except ImportError as exc:
                raise RuntimeError(
                    "Parquet preview requires the 'web' extra with duckdb"
                ) from exc
            quoted = str(path).replace("'", "''")
            connection = duckdb.connect()
            try:
                cursor = connection.execute(
                    f"SELECT * FROM read_parquet('{quoted}') LIMIT {safe_limit + 1} OFFSET {safe_offset}"
                )
                columns = [str(item[0]) for item in cursor.description]
                rows = [dict(zip(columns, values)) for values in cursor.fetchall()]
            finally:
                connection.close()
            return self._record_payload(rows, safe_offset, safe_limit)
        raise ValueError("artifact does not support record preview")

    def artifact_path(self, artifact_id: str, *, user_id: str = LOCAL_USER_ID) -> Path:
        return self.store.resolve(
            self.get_artifact(artifact_id, user_id=user_id)["storage_key"]
        )

    def thumbnail_path(self, artifact_id: str, *, user_id: str = LOCAL_USER_ID) -> Path:
        user = self._identifier(user_id, "user_id")
        artifact = self.get_artifact(artifact_id, user_id=user)
        if artifact["kind"] != "image":
            raise ValueError("artifact is not an image")
        source = self.store.resolve(artifact["storage_key"])
        target = self._user_root(user) / "cache" / "thumbnails" / f"{artifact_id}.webp"
        if target.exists():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            from PIL import Image
        except ImportError:
            return source
        with Image.open(source) as image:
            image.thumbnail((512, 512))
            image.convert("RGB").save(target, "WEBP", quality=82)
        return target

    def delete_artifact(self, artifact_id: str, *, user_id: str) -> None:
        path = self.artifact_path(artifact_id, user_id=user_id)
        if not self.catalog.delete_artifact(artifact_id, user_id=user_id):
            raise KeyError(f"unknown artifact: {artifact_id}")
        path.unlink(missing_ok=True)

    def _build_manifest(
        self, user_id: str, app_id: str, run_id: str, run_dir: Path
    ) -> dict[str, Any]:
        artifacts: list[dict[str, Any]] = []
        paths = sorted(item for item in run_dir.rglob("*") if item.is_file())
        for path in paths:
            relative = path.relative_to(run_dir)
            if path.name == "manifest.json" or ".djx" in relative.parts:
                continue
            if path.is_symlink():
                raise ValueError(
                    f"symbolic links are not allowed in run outputs: {relative}"
                )
            classification = self._classify(path)
            role = {
                "plans": "plan",
                "recipes": "recipe",
                "outputs": classification["role"],
                "logs": "log",
            }.get(relative.parts[0], classification["role"])
            artifacts.append(
                {
                    "id": f"art_{uuid4().hex[:12]}",
                    "user_id": user_id,
                    "app_id": app_id,
                    "run_id": run_id,
                    "name": path.name,
                    "relative_path": relative.as_posix(),
                    "kind": classification["kind"],
                    "role": role,
                    "format": classification["format"],
                    "mime_type": classification["mime_type"],
                    "byte_size": path.stat().st_size,
                    "status": "ready",
                    "metadata": {"sha256": self._sha256(path)},
                }
            )
        return {
            "schema_version": 2,
            "user_id": user_id,
            "app_id": app_id,
            "run_id": run_id,
            "artifact_count": len(artifacts),
            "artifacts": artifacts,
        }

    def _user_root(self, user_id: str) -> Path:
        segment = "u_" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:24]
        return self.settings.home / "users" / segment

    @staticmethod
    def _classify(path: Path) -> dict[str, str]:
        suffix = path.suffix.lower()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if suffix == ".json":
            kind, role, fmt = "json", "document", "json"
        elif suffix in {".jsonl", ".ndjson"}:
            kind, role, fmt = "jsonl", "records", "jsonl"
        elif suffix in {".parquet", ".parq"}:
            kind, role, fmt = "parquet", "records", "parquet"
        elif suffix in IMAGE_SUFFIXES:
            kind, role, fmt = "image", "media", suffix.lstrip(".")
        elif suffix in TEXT_SUFFIXES:
            kind, role, fmt = "text", "document", suffix.lstrip(".")
        else:
            kind, role, fmt = "binary", "file", suffix.lstrip(".") or "binary"
        return {"kind": kind, "role": role, "format": fmt, "mime_type": mime}

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _record_payload(rows: list[Any], offset: int, limit: int) -> dict[str, Any]:
        visible, columns = rows[:limit], []
        for row in visible:
            if isinstance(row, dict):
                for key in row:
                    if key not in columns:
                        columns.append(key)
        return {
            "columns": columns,
            "rows": visible,
            "offset": offset,
            "limit": limit,
            "has_more": len(rows) > limit,
        }

    @staticmethod
    def _identifier(value: str, label: str) -> str:
        token = str(value or "").strip()
        if not token or not all(char.isalnum() or char in "_-" for char in token):
            raise ValueError(f"invalid {label}: {value!r}")
        return token
