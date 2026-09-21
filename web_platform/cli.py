"""Command line entry point for a bare DJ Agent installation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .service import ArtifactPlatform
from .settings import PlatformSettings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dj-web")
    parser.add_argument(
        "--home", help="platform data root; defaults to <agent-root>/platform"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="initialize platform directories and SQLite catalog")
    serve = sub.add_parser("serve", help="serve the API and bundled React frontend")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8080, type=int)
    begin = sub.add_parser("begin-run", help="create an isolated run layout")
    begin.add_argument("app_id")
    finish = sub.add_parser("finalize-run", help="commit and catalog a run's outputs")
    finish.add_argument("run_id")
    sub.add_parser(
        "doctor", help="check storage, database, and optional preview dependencies"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = PlatformSettings.load(args.home)
    platform = ArtifactPlatform(settings)
    platform.initialize()

    if args.command == "init":
        print(
            json.dumps(
                {"ok": True, "platform_home": str(settings.home)}, ensure_ascii=False
            )
        )
        return 0
    if args.command == "begin-run":
        print(
            json.dumps(
                platform.begin_run(args.app_id).to_dict(), ensure_ascii=False, indent=2
            )
        )
        return 0
    if args.command == "finalize-run":
        print(
            json.dumps(platform.finalize_run(args.run_id), ensure_ascii=False, indent=2)
        )
        return 0
    if args.command == "doctor":
        optional = {}
        for name in ("fastapi", "uvicorn", "duckdb", "PIL"):
            try:
                __import__(name)
                optional[name] = True
            except ImportError:
                optional[name] = False
        result = {
            "ok": optional["fastapi"] and optional["uvicorn"],
            "platform_home": str(settings.home),
            "database": str(settings.database_path),
            "writable": settings.home.exists() and settings.home.is_dir(),
            "optional_dependencies": optional,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if args.command == "serve":
        try:
            import uvicorn
        except ImportError as exc:
            raise SystemExit("dj-web serve requires `pip install -e '.[web]'`") from exc
        from .api import create_app

        uvicorn.run(create_app(settings), host=args.host, port=args.port)
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
