"""Web-only argument adaptation; native tools and CLI retain their contracts."""

from dataclasses import replace

from data_juicer_agents.core.tool import ToolSpec


def bind_export_path(spec: ToolSpec, resolve_export) -> ToolSpec:
    if spec.name not in {"build_dataset_spec", "plan_save"}:
        return spec

    def execute(ctx, args):
        # Adapt a private argument copy, never the shared ToolSpec or input.
        adapted = args.model_copy(deep=True)
        if spec.name == "build_dataset_spec":
            adapted.export_path = resolve_export(
                adapted.export_path, (adapted.model_extra or {}).get("export_type"),
            )
        else:
            recipe = adapted.plan_payload.get("recipe")
            if isinstance(recipe, dict):
                recipe["export_path"] = resolve_export(
                    recipe.get("export_path"), recipe.get("export_type"),
                )
        return spec.executor(ctx, adapted)

    return replace(spec, executor=execute)


def build_web_toolkit(runtime, resolve_export):
    from agentscope.tool import Toolkit
    from data_juicer_agents.adapters.agentscope.tools import (
        build_agentscope_json_schema, build_agentscope_tool_function,
    )
    from data_juicer_agents.capabilities.session.toolkit import (
        _build_tool_context, get_session_tool_specs,
    )

    toolkit = Toolkit()
    for native_spec in get_session_tool_specs():
        spec = bind_export_path(native_spec, resolve_export)
        func = build_agentscope_tool_function(
            spec, ctx_factory=lambda: _build_tool_context(runtime),
            runtime_invoke=runtime.invoke_tool,
        )
        toolkit.register_tool_function(func, json_schema=build_agentscope_json_schema(spec))
    return toolkit
