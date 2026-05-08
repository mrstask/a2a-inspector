"""High-fidelity mock of the IDA Navigation Agent for A2A inspector testing.

The real Navigation Agent (``tto-ida-navigation-agent``) speaks A2A with
``ui_tool_call`` data parts:

* For every missing route parameter it emits a selector ``ui_tool_call``
  (e.g. ``workareaSelector``) inside an ``input-required`` task. The selector
  call carries inherited context (``client.id``, ``project.id``,
  ``workAreaId`` etc.) and a human ``ui_tool__clarification`` preamble.
* When all parameters are resolved it emits a final ``navigation``
  ``ui_tool_call`` with ``args.url`` and marks the task ``completed``.

This mock reproduces the same wire shape using a hand-curated route table —
no LLM, no Ollama, no Deloitte packages required — so the inspector UI can
be exercised against realistic payloads on a Mac before the maintainer
re-tests against the real agent on Windows.

Run::

    uv run python examples/navigation_mock_agent.py

The mock listens on ``http://127.0.0.1:5558`` by default. Connect the
inspector to it and try prompts such as:

* ``Go to the Reports page`` -> single-turn navigation
* ``Open task`` -> ``workareaSelector`` -> ``workplanTaskSelector`` -> nav
* ``Take me to a document``
* ``Take me to IDA personalization settings``
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.apps.jsonrpc import A2AStarletteApplication
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentSkill,
    DataPart,
    Part,
    TaskState,
    TextPart,
)


logger = logging.getLogger("navigation_mock_agent")


# ---------------------------------------------------------------------------
# Route + selector model (mirrors COMMON_ROUTE_PARAMETERS in the real agent)
# ---------------------------------------------------------------------------


SELECTOR_LABELS: dict[str, str] = {
    "clientSelector": "Client",
    "projectSelector": "Project",
    "workareaSelector": "Work Area",
    "entitySelector": "Legal Entity",
    "entityCollectionSelector": "Legal Entities Collection",
    "workplanTaskSelector": "Workplan Task",
    "documentSelector": "Document",
    "informationRequestSelector": "Information Request",
    "dataPreparationTaskSelector": "Data Preparation",
    "dataMappingTaskSelector": "Data Mapping",
    "flowSelector": "Flow",
    "canvasSelector": "Hierarchy Visualization",
    "analyticReportSelector": "Report",
}


@dataclass(frozen=True)
class ParamSpec:
    """A single route parameter resolvable via a UI selector tool."""

    key: str
    selector: str
    inherits: tuple[str, ...] = ()
    """Other params that, once resolved, should be passed as args context."""

    @property
    def label(self) -> str:
        return SELECTOR_LABELS.get(self.selector, self.selector)


PARAMS: dict[str, ParamSpec] = {
    "client_id": ParamSpec("client_id", "clientSelector"),
    "project_id": ParamSpec("project_id", "projectSelector", inherits=("client_id",)),
    "work_area_id": ParamSpec(
        "work_area_id", "workareaSelector", inherits=("client_id", "project_id")
    ),
    "entity_id": ParamSpec(
        "entity_id", "entitySelector", inherits=("project_id", "work_area_id")
    ),
    "task_id": ParamSpec(
        "task_id", "workplanTaskSelector", inherits=("work_area_id",)
    ),
    "document_id": ParamSpec(
        "document_id", "documentSelector", inherits=("work_area_id",)
    ),
    "info_request_id": ParamSpec(
        "info_request_id", "informationRequestSelector", inherits=("work_area_id",)
    ),
    "data_preparation_id": ParamSpec(
        "data_preparation_id",
        "dataPreparationTaskSelector",
        inherits=("work_area_id",),
    ),
    "report_id": ParamSpec(
        "report_id", "analyticReportSelector", inherits=("work_area_id",)
    ),
    "flow_id": ParamSpec("flow_id", "flowSelector", inherits=("work_area_id",)),
}


@dataclass(frozen=True)
class Route:
    """A canonical Intela URL pattern.

    ``template`` uses ``:param`` placeholders. ``params`` lists the
    placeholder names in order; the executor walks them and emits selector
    calls for the first one that's still unresolved.
    """

    name: str
    template: str
    params: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()


ROUTES: list[Route] = [
    # --- Pure pages (no params) -------------------------------------------------
    Route(
        "Reports",
        "/reports",
        params=(),
        keywords=("report", "reports", "analytics"),
    ),
    Route(
        "Workplan",
        "/workplan",
        params=(),
        keywords=("workplan", "work plan"),
    ),
    Route(
        "Help Center",
        "/help-center",
        params=(),
        keywords=("help center", "help", "feedback", "raise an issue"),
    ),
    Route(
        "IDA Personalization Settings",
        "/settings/personalization",
        params=(),
        keywords=("personalization", "voice", "avatar", "ida settings"),
    ),
    Route(
        "Clients list",
        "/clients",
        params=(),
        keywords=("clients list", "all clients", "list of clients"),
    ),
    Route(
        "Projects list",
        "/projects",
        params=(),
        keywords=("projects list", "all projects", "list of projects"),
    ),
    # --- Item pages (require selectors) ----------------------------------------
    Route(
        "Work Area Dashboard",
        "/work-areas/:work_area_id",
        params=("work_area_id",),
        keywords=("work area", "workarea"),
    ),
    Route(
        "Work Area Data Preparation list",
        "/work-areas/:work_area_id/data-preparation",
        params=("work_area_id",),
        keywords=("data preparation page", "data preparation list"),
    ),
    Route(
        "Data Preparation Item",
        "/work-areas/:work_area_id/data-preparation/:data_preparation_id",
        params=("work_area_id", "data_preparation_id"),
        keywords=("data preparation",),
    ),
    Route(
        "Workplan Task",
        "/work-areas/:work_area_id/workplan/:task_id",
        params=("work_area_id", "task_id"),
        keywords=("task", "workplan task", "q4 filing"),
    ),
    Route(
        "Document",
        "/work-areas/:work_area_id/documents/:document_id",
        params=("work_area_id", "document_id"),
        keywords=("document", "annual report"),
    ),
    Route(
        "Information Request",
        "/work-areas/:work_area_id/info-requests/:info_request_id",
        params=("work_area_id", "info_request_id"),
        keywords=("information request", "info request", "ir "),
    ),
    Route(
        "Entity",
        "/projects/:project_id/entities/:entity_id",
        params=("project_id", "entity_id"),
        keywords=("entity", "abc corporation"),
    ),
    Route(
        "Project Dashboard",
        "/projects/:project_id",
        params=("project_id",),
        keywords=("project",),
    ),
    Route(
        "Client Dashboard",
        "/clients/:client_id",
        params=("client_id",),
        keywords=("client",),
    ),
]


# ---------------------------------------------------------------------------
# Session state (per A2A context_id)
# ---------------------------------------------------------------------------


@dataclass
class Session:
    route: Route
    resolved: dict[str, str] = field(default_factory=dict)

    def next_param(self) -> str | None:
        for key in self.route.params:
            if key not in self.resolved:
                return key
        return None


SESSIONS: dict[str, Session] = {}


# ---------------------------------------------------------------------------
# Routing helpers
# ---------------------------------------------------------------------------


_NAVIGATION_TRIGGERS = re.compile(
    r"\b(go to|take me|bring me|open|navigate|locate|view|list|"
    r"where is|access|jump to|return to|back to|see|show|display|find)\b",
    re.IGNORECASE,
)


def match_route(query: str) -> Route | None:
    """Pick the most specific route whose keyword appears in the query."""
    lower = query.lower()
    best: tuple[int, int, Route] | None = None  # (specificity, kw_len, route)

    for route in ROUTES:
        for kw in route.keywords:
            if kw in lower:
                # Prefer routes that need MORE selectors when the query implies
                # an item ("open task" -> Workplan Task, not /workplan list).
                specificity = len(route.params)
                if best is None or (specificity, len(kw)) > (best[0], best[1]):
                    best = (specificity, len(kw), route)
                break

    return best[2] if best else None


def fake_uuid(seed: str) -> str:
    """Deterministic UUID per (context, key) so demo URLs are stable."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def render_url(route: Route, resolved: dict[str, str]) -> str:
    url = route.template
    for key, value in resolved.items():
        url = url.replace(f":{key}", value)
    return url


def selector_args(spec: ParamSpec, resolved: dict[str, str]) -> dict[str, object]:
    """Build the args dict the way the real agent does — nested context."""
    args: dict[str, object] = {}
    for parent_key in spec.inherits:
        parent_value = resolved.get(parent_key)
        if not parent_value:
            continue
        if parent_key == "client_id":
            args["client"] = {"id": parent_value, "name": "ACME Corporation"}
        elif parent_key == "project_id":
            args["project"] = {"id": parent_value, "name": "Q4 Compliance"}
        elif parent_key == "work_area_id":
            # Both workAreaId and etpContainerId are real arg names, see
            # tool_arg_mapping in the production COMMON_ROUTE_PARAMETERS.
            args["workAreaId"] = parent_value
            args["etpContainerId"] = parent_value
    args["ui_tool__clarification"] = (
        f"To continue, please choose the {spec.label} you want to work with."
    )
    return args


# ---------------------------------------------------------------------------
# A2A executor
# ---------------------------------------------------------------------------


def text_part(text: str) -> Part:
    return Part(root=TextPart(text=text))


def ui_tool_call_part(name: str, args: dict[str, object]) -> Part:
    return Part(
        root=DataPart(
            data={"type": "ui_tool_call", "data": {"name": name, "args": args}}
        )
    )


class NavigationMockExecutor(AgentExecutor):
    """Multi-turn ui_tool_call mock following the real Navigation Agent flow."""

    async def execute(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        if not context.task_id or not context.context_id:
            raise RuntimeError("A2A request context did not include IDs")

        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        prompt = (context.get_user_input() or "").strip()
        ctx_id = context.context_id

        await updater.update_status(
            TaskState.working,
            message=updater.new_agent_message(
                [text_part("Resolving navigation request...")]
            ),
        )

        session = SESSIONS.get(ctx_id)
        if session is None:
            await self._start_new_flow(updater, ctx_id, prompt)
        else:
            await self._continue_flow(updater, ctx_id, session, prompt)

    async def _start_new_flow(
        self, updater: TaskUpdater, ctx_id: str, prompt: str
    ) -> None:
        if not prompt:
            await updater.failed(
                message=updater.new_agent_message(
                    [text_part("Send a navigation prompt to test this agent.")]
                )
            )
            return

        if not _NAVIGATION_TRIGGERS.search(prompt) and not match_route(prompt):
            await updater.update_status(
                TaskState.completed,
                message=updater.new_agent_message(
                    [
                        text_part(
                            "I only handle navigation requests. Try things like "
                            "'go to Reports', 'open task', or 'take me to a document'."
                        )
                    ]
                ),
                final=True,
            )
            return

        route = match_route(prompt)
        if route is None:
            await updater.update_status(
                TaskState.completed,
                message=updater.new_agent_message(
                    [
                        text_part(
                            f"Sorry, I couldn't map '{prompt}' to a known route. "
                            "Try 'go to Reports' or 'open task'."
                        )
                    ]
                ),
                final=True,
            )
            return

        session = Session(route=route)
        SESSIONS[ctx_id] = session
        await self._advance(updater, ctx_id, session)

    async def _continue_flow(
        self,
        updater: TaskUpdater,
        ctx_id: str,
        session: Session,
        prompt: str,
    ) -> None:
        # Simulate the UI sending back the selected item. The real client
        # posts JSON like {"id": "<uuid>", ...}; we just synthesise an id.
        pending = session.next_param()
        if pending is not None:
            seed = f"{ctx_id}:{pending}:{prompt}"
            session.resolved[pending] = fake_uuid(seed)
            logger.info(
                "ctx=%s resolved %s -> %s", ctx_id, pending, session.resolved[pending]
            )

        await self._advance(updater, ctx_id, session)

    async def _advance(
        self, updater: TaskUpdater, ctx_id: str, session: Session
    ) -> None:
        pending = session.next_param()
        if pending is None:
            url = render_url(session.route, session.resolved)
            await updater.update_status(
                TaskState.completed,
                message=updater.new_agent_message(
                    [
                        text_part(
                            f"Routing you to **{session.route.name}** at `{url}`."
                        ),
                        ui_tool_call_part("navigation", {"url": url}),
                    ]
                ),
                final=True,
                metadata={"agent": "navigation_mock", "route": session.route.template},
            )
            SESSIONS.pop(ctx_id, None)
            return

        spec = PARAMS[pending]
        args = selector_args(spec, session.resolved)
        clarification = args["ui_tool__clarification"]
        await updater.update_status(
            TaskState.input_required,
            message=updater.new_agent_message(
                [
                    text_part(str(clarification)),
                    ui_tool_call_part(spec.selector, args),
                ]
            ),
            final=True,
            metadata={
                "agent": "navigation_mock",
                "selector": spec.selector,
                "param": pending,
                "route": session.route.template,
            },
        )

    async def cancel(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        if context.context_id:
            SESSIONS.pop(context.context_id, None)
        if context.task_id and context.context_id:
            updater = TaskUpdater(
                event_queue, context.task_id, context.context_id
            )
            await updater.cancel(
                message=updater.new_agent_message(
                    [text_part("Canceled navigation mock request.")]
                )
            )


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------


def build_agent_card(host: str, port: int) -> AgentCard:
    public_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{public_host}:{port}/"
    description = (
        "Mock NavigationAgent for A2A inspector UI testing. Mirrors the real "
        "IDA Navigation Agent's ui_tool_call protocol: emits selector tool "
        "calls (workareaSelector, workplanTaskSelector, documentSelector, "
        "informationRequestSelector, dataPreparationTaskSelector, ...) inside "
        "input-required tasks and a final navigation tool call inside a "
        "completed task. No LLM or Deloitte packages required."
    )
    return AgentCard(
        name="NavigationAgent (mock)",
        description=description,
        url=url,
        version="0.1.0",
        protocol_version="0.3.0",
        preferred_transport="JSONRPC",
        capabilities=AgentCapabilities(
            streaming=False,
            state_transition_history=True,
        ),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain", "application/json"],
        skills=[
            AgentSkill(
                id="navigation_agent_skill",
                name="Navigation Agent Skill",
                description=(
                    "Mock of the production navigation skill — resolves Intela "
                    "routes (work areas, workplan tasks, documents, info "
                    "requests, data preparation, reports) by issuing selector "
                    "ui_tool_calls when parameters are missing."
                ),
                tags=["navigation", "site-map", "mock"],
                examples=[
                    "Go to the Reports page",
                    "Open task 'Q4 Tax Filing'",
                    "Take me to a document",
                    "Navigate me to an information request",
                    "Show data preparation",
                    "Take me to IDA personalization settings",
                ],
            ),
            AgentSkill(
                id="ida_settings_customization_skill",
                name="IDA Settings Customization Skill",
                description="Customize IDA Settings, including changing voice and avatar (mock).",
                tags=["ida_settings", "mock"],
                examples=[
                    "Change IDA's voice or avatar",
                    "Take me to IDA personalization settings",
                ],
            ),
            AgentSkill(
                id="help_center_skill",
                name="Help Center Skill",
                description="Navigate to the Help Center or submit feedback (mock).",
                tags=["help_center", "mock"],
                examples=[
                    "Submit feedback on Intela or raise an issue",
                    "Take me to the Help Center",
                ],
            ),
        ],
    )


def build_app(host: str, port: int):
    handler = DefaultRequestHandler(
        agent_executor=NavigationMockExecutor(),
        task_store=InMemoryTaskStore(),
    )
    server = A2AStarletteApplication(
        agent_card=build_agent_card(host, port),
        http_handler=handler,
    )
    return server.build()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("NAV_MOCK_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.getenv("NAV_MOCK_PORT", "5558"))
    )
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = build_app(args.host, args.port)
    print(
        f"NavigationAgent (mock) listening at http://{args.host}:{args.port}/ "
        f"— connect the inspector and try 'go to Reports' or 'open task'."
    )
    uvicorn.run(app, host=args.host, port=args.port)


# Re-exported so tests / other tools can import without invoking uvicorn.
__all__ = [
    "ROUTES",
    "PARAMS",
    "SELECTOR_LABELS",
    "Route",
    "ParamSpec",
    "Session",
    "NavigationMockExecutor",
    "build_app",
    "build_agent_card",
    "match_route",
    "render_url",
    "selector_args",
    "fake_uuid",
]


_TextPartCallable = Callable[[str], Part]
_ToolPartCallable = Callable[[str, dict[str, object]], Part]
_AsyncCallable = Callable[..., Awaitable[None]]


if __name__ == "__main__":
    main()
