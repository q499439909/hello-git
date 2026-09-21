"""Adapter that runs existing DJ plans inside a platform-managed run layout."""

from __future__ import annotations

import copy
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from data_juicer_agents.capabilities.session.runtime import SessionState
from data_juicer_agents.tools.apply.apply_recipe.logic import ApplyResult, ApplyUseCase

from .service import ArtifactPlatform, RunLayout


@dataclass(frozen=True)
class PlatformRunResult:
    layout: RunLayout
    execution: ApplyResult
    returncode: int
    artifact_result: dict[str, Any] | None


class DjAgentRuntimeAdapter:
    """Keeps DJ Agent runtime details behind one portable interface."""

    def __init__(self, platform: ArtifactPlatform) -> None:
        self.platform = platform

    def session_state(
        self,
        layout: RunLayout,
        *,
        dataset_path: str | None = None,
    ) -> SessionState:
        return SessionState(
            dataset_path=dataset_path,
            export_path=None,
            working_dir=str(layout.working_dir),
        )

    def execute_plan(
        self,
        app_id: str,
        plan_payload: dict[str, Any],
        *,
        user_id: str = "local",
        session_id: str | None = None,
        dry_run: bool = False,
        timeout_seconds: int = 300,
        command_override: str | Iterable[str] | None = None,
    ) -> PlatformRunResult:
        plan = copy.deepcopy(plan_payload)
        recipe = plan.get("recipe")
        if not isinstance(recipe, dict):
            raise ValueError("plan must contain a recipe object")
        layout = self.platform.begin_run(app_id, user_id=user_id, session_id=session_id)
        recipe["export_path"] = str(
            layout.export_file(
                recipe.get("export_path"),
                recipe.get("export_type"),
            )
        )

        recipe_runtime_dir = layout.working_dir / "recipes"
        result, returncode, stdout, stderr = ApplyUseCase().execute(
            plan,
            recipe_runtime_dir,
            dry_run=dry_run,
            timeout_seconds=timeout_seconds,
            command_override=command_override,
        )
        (layout.logs_dir / "stdout.log").write_text(stdout, encoding="utf-8")
        (layout.logs_dir / "stderr.log").write_text(stderr, encoding="utf-8")
        recipe_output_dir = layout.output_dir / "recipe"
        recipe_output_dir.mkdir(parents=True, exist_ok=True)
        generated_recipe = Path(result.generated_recipe_path)
        if generated_recipe.is_file():
            shutil.copy2(generated_recipe, recipe_output_dir / generated_recipe.name)

        if returncode != 0:
            self.platform.catalog.fail_run(
                layout.run_id, result.error_message, user_id=layout.user_id
            )
            return PlatformRunResult(layout, result, returncode, None)

        artifact_result = self.platform.finalize_run(
            layout.run_id, user_id=layout.user_id
        )
        return PlatformRunResult(layout, result, returncode, artifact_result)
