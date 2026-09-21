"""Safe local filesystem adapter for platform artifacts."""

from __future__ import annotations

import shutil
from pathlib import Path, PurePosixPath


class UnsafeStorageKey(ValueError):
    pass


class LocalArtifactStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    @staticmethod
    def _normalize_key(storage_key: str) -> str:
        key = str(storage_key or "").replace("\\", "/").strip("/")
        path = PurePosixPath(key)
        if not key or path.is_absolute() or ".." in path.parts:
            raise UnsafeStorageKey(f"unsafe storage key: {storage_key!r}")
        return path.as_posix()

    def resolve(self, storage_key: str, *, must_exist: bool = True) -> Path:
        key = self._normalize_key(storage_key)
        candidate = (self.root / Path(*PurePosixPath(key).parts)).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise UnsafeStorageKey(
                f"storage key escapes platform root: {key!r}"
            ) from exc
        if must_exist and not candidate.exists():
            raise FileNotFoundError(candidate)
        return candidate

    def key_for(self, path: Path) -> str:
        resolved = path.resolve()
        try:
            return resolved.relative_to(self.root).as_posix()
        except ValueError as exc:
            raise UnsafeStorageKey(f"path is outside platform root: {path}") from exc

    def commit_directory(self, source_key: str, target_key: str) -> Path:
        source = self.resolve(source_key)
        target = self.resolve(target_key, must_exist=False)
        if target.exists():
            raise FileExistsError(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        source.replace(target)
        return target

    def remove_tree(self, storage_key: str) -> None:
        target = self.resolve(storage_key)
        if target == self.root:
            raise UnsafeStorageKey("refusing to remove platform root")
        shutil.rmtree(target)
