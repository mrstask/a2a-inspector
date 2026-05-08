"""Small local A2A agents backed by Ollama.

Run this module twice with different --agent values, or use
examples/run_ollama_agents.sh to start both test agents.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass

import httpx
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


DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:latest")
DEFAULT_OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")


@dataclass(frozen=True)
class AgentConfig:
    key: str
    name: str
    description: str
    port: int
    system_prompt: str
    tags: list[str]
    examples: list[str]


AGENTS: dict[str, AgentConfig] = {
    "assistant": AgentConfig(
        key="assistant",
        name="Gemma Local Assistant",
        description=(
            "A friendly local A2A test agent that answers with concise, "
            "useful text from Ollama."
        ),
        port=5555,
        system_prompt=(
            "You are a concise local test assistant for an A2A inspector. "
            "Answer directly, keep responses short, and mention when the "
            "question is ambiguous."
        ),
        tags=["ollama", "gemma", "chat", "smoke-test"],
        examples=[
            "Summarize what an A2A inspector does.",
            "Give me three ideas for testing this UI.",
        ],
    ),
    "navigation": AgentConfig(
        key="navigation",
        name="UI Navigation Demo",
        description=(
            "A local A2A test agent that emits kind=data / ui_tool_call parts "
            "to exercise the inspector's Navigation Pill and Awaiting Input "
            "Badge rendering."
        ),
        port=5557,
        system_prompt="",
        tags=["ui-tool-call", "navigation", "demo"],
        examples=[
            "go to data preparation",
            "open work area dashboard",
            "select task",
            "select work area",
            "start",
        ],
    ),
    "structured": AgentConfig(
        key="structured",
        name="Gemma Structured QA",
        description=(
            "A local A2A test agent that returns scanner-friendly structured "
            "answers for UI validation."
        ),
        port=5556,
        system_prompt=(
            "You are a structured QA agent for testing an A2A inspector UI. "
            "Return answers with these sections: Summary, Checks, Edge Cases. "
            "Keep each section compact."
        ),
        tags=["ollama", "gemma", "qa", "structured-output"],
        examples=[
            "Create a test checklist for file attachments.",
            "List edge cases for reconnecting to an agent.",
        ],
    ),
}


class OllamaA2AExecutor(AgentExecutor):
    def __init__(
        self,
        config: AgentConfig,
        model: str,
        ollama_url: str,
        timeout_seconds: float,
    ) -> None:
        self.config = config
        self.model = model
        self.ollama_url = ollama_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def execute(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        task_id = context.task_id
        context_id = context.context_id
        if not task_id or not context_id:
            raise RuntimeError("A2A request context did not include IDs")

        updater = TaskUpdater(event_queue, task_id, context_id)
        await updater.update_status(
            TaskState.working,
            message=updater.new_agent_message(
                [text_part(f"Calling Ollama model {self.model}...")]
            ),
        )

        prompt = context.get_user_input().strip()
        if not prompt:
            await updater.failed(
                message=updater.new_agent_message(
                    [text_part("Send a text prompt to test this agent.")]
                )
            )
            return

        answer = await self._ask_ollama(prompt)
        final_message = updater.new_agent_message(
            [text_part(answer)],
            metadata={
                "agent": self.config.key,
                "model": self.model,
                "provider": "ollama",
            },
        )
        await updater.update_status(
            TaskState.completed,
            message=final_message,
            metadata={"agent": self.config.key, "model": self.model},
        )

    async def cancel(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        if not context.task_id or not context.context_id:
            return
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel(
            message=updater.new_agent_message(
                [text_part("Canceled local Ollama test agent request.")]
            )
        )

    async def _ask_ollama(self, prompt: str) -> str:
        payload = {
            "model": self.model,
            "stream": False,
            "think": False,
            "messages": [
                {"role": "system", "content": self.config.system_prompt},
                {"role": "user", "content": prompt},
            ],
            "options": {
                "temperature": 0.3,
                "num_predict": 768,
            },
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.ollama_url}/api/chat", json=payload
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            return (
                "Ollama returned an HTTP error while testing the UI.\n\n"
                f"Status: {exc.response.status_code}\n"
                f"Body: {exc.response.text[:800]}"
            )
        except httpx.RequestError as exc:
            return (
                "Could not reach Ollama while testing the UI.\n\n"
                f"Base URL: {self.ollama_url}\n"
                f"Model: {self.model}\n"
                f"Error: {exc}\n\n"
                "Start Ollama and make sure the model is available."
            )

        content = data.get("message", {}).get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()

        thinking = data.get("message", {}).get("thinking")
        if isinstance(thinking, str) and thinking.strip():
            return (
                "Ollama returned reasoning text but no final answer. "
                "Try a shorter prompt, raise OLLAMA_TIMEOUT, or use a "
                "non-thinking model for this smoke test."
            )

        return (
            "Ollama response did not include message.content. "
            f"Top-level keys: {', '.join(sorted(data.keys()))}"
        )


def text_part(text: str) -> Part:
    return Part(root=TextPart(text=text))


def ui_tool_call_part(
    name: str, args: dict[str, object] | None = None
) -> Part:
    """Build a kind=data part wrapping a ui_tool_call payload.

    The shape matches the IDA Navigation Agent contract that the inspector
    renders as Navigation Pills / Awaiting Input Badges.
    """
    return Part(
        root=DataPart(
            data={
                "type": "ui_tool_call",
                "data": {"name": name, "args": dict(args or {})},
            }
        )
    )


NAV_ROUTES: dict[str, str] = {
    "data preparation": "/work-areas/37787232-b8c3-4846-a3bc-30b3687c088e/data-preparation",
    "work area": "/work-areas/37787232-b8c3-4846-a3bc-30b3687c088e",
    "dashboard": "/dashboard",
    "settings": "/settings",
}


def match_navigation(prompt: str) -> str | None:
    lower = prompt.lower()
    for keyword, url in NAV_ROUTES.items():
        if keyword in lower:
            return url
    return None


def match_selector(prompt: str) -> str | None:
    lower = prompt.lower()
    if "data preparation" in lower and "task" in lower:
        return "dataPreparationTaskSelector"
    if "work area" in lower or "workarea" in lower:
        return "workareaSelector"
    if "select" in lower or lower.strip() in {"", "start", "begin"}:
        return "workareaSelector"
    return None


class NavigationDemoExecutor(AgentExecutor):
    """Emits kind=data ui_tool_call parts to exercise the inspector UI."""

    def __init__(self, config: AgentConfig) -> None:
        self.config = config

    async def execute(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        task_id = context.task_id
        context_id = context.context_id
        if not task_id or not context_id:
            raise RuntimeError("A2A request context did not include IDs")

        updater = TaskUpdater(event_queue, task_id, context_id)
        prompt = context.get_user_input().strip()

        await updater.update_status(
            TaskState.working,
            message=updater.new_agent_message(
                [text_part("Resolving UI tool call demo...")]
            ),
        )

        url = match_navigation(prompt)
        if url is not None:
            nav_part = ui_tool_call_part("navigation", {"url": url})
            text = text_part(f"Routing you to **{url}**.")
            await updater.update_status(
                TaskState.completed,
                message=updater.new_agent_message([text, nav_part]),
                metadata={"agent": self.config.key, "demo": "navigation"},
            )
            return

        selector = match_selector(prompt) or "workareaSelector"
        sel_part = ui_tool_call_part(selector)
        prompt_text = text_part(
            f"Pick an item from the **{selector}** widget to continue."
        )
        await updater.update_status(
            TaskState.input_required,
            message=updater.new_agent_message([prompt_text, sel_part]),
            metadata={"agent": self.config.key, "demo": "selector"},
            final=True,
        )

    async def cancel(
        self, context: RequestContext, event_queue: EventQueue
    ) -> None:
        if not context.task_id or not context.context_id:
            return
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel(
            message=updater.new_agent_message(
                [text_part("Canceled UI navigation demo request.")]
            )
        )


def build_agent_card(config: AgentConfig, host: str, model: str) -> AgentCard:
    public_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{public_host}:{config.port}/"
    description = (
        config.description
        if config.key == "navigation"
        else f"{config.description} Model: {model}."
    )
    output_modes = (
        ["text/plain", "application/json"]
        if config.key == "navigation"
        else ["text/plain"]
    )
    return AgentCard(
        name=config.name,
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
        default_output_modes=output_modes,
        skills=[
            AgentSkill(
                id=f"{config.key}-chat",
                name=config.name,
                description=config.description,
                tags=config.tags,
                examples=config.examples,
            )
        ],
    )


def build_app(
    config: AgentConfig,
    host: str,
    model: str,
    ollama_url: str,
    timeout_seconds: float,
):
    if config.key == "navigation":
        executor: AgentExecutor = NavigationDemoExecutor(config=config)
    else:
        executor = OllamaA2AExecutor(
            config=config,
            model=model,
            ollama_url=ollama_url,
            timeout_seconds=timeout_seconds,
        )
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
    )
    server = A2AStarletteApplication(
        agent_card=build_agent_card(config, host, model),
        http_handler=handler,
    )
    return server.build()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--agent",
        choices=sorted(AGENTS),
        default="assistant",
        help="Which test agent persona to run.",
    )
    parser.add_argument("--host", default=os.getenv("A2A_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.getenv("OLLAMA_TIMEOUT", "120")),
        help="Seconds to wait for a local Ollama response.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = AGENTS[args.agent]
    if args.port is not None:
        config = AgentConfig(
            **{**config.__dict__, "port": args.port}
        )
    app = build_app(
        config=config,
        host=args.host,
        model=args.model,
        ollama_url=args.ollama_url,
        timeout_seconds=args.timeout,
    )
    print(
        f"{config.name} listening at http://{args.host}:{config.port}/ "
        f"using {args.model} via {args.ollama_url}"
    )
    uvicorn.run(app, host=args.host, port=config.port)


if __name__ == "__main__":
    main()
