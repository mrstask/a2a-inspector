# Local Ollama A2A Test Agents

This folder contains two small A2A agents for testing the inspector UI with
Ollama and `gemma4:latest`.

## Prerequisites

Make sure Ollama is running and the model exists locally:

```sh
ollama pull gemma4:latest
ollama serve
```

If your Ollama process is already running, you only need the pull command.

## Run both agents

From the repo root:

```sh
bash examples/run_ollama_agents.sh
```

The script starts:

- `http://127.0.0.1:5555/` - Gemma Local Assistant
- `http://127.0.0.1:5556/` - Gemma Structured QA

Paste either URL into the A2A Inspector URL field and click Connect.

## Configuration

You can override the model or Ollama endpoint with environment variables:

```sh
OLLAMA_MODEL=gemma4:latest \
OLLAMA_BASE_URL=http://127.0.0.1:11434 \
bash examples/run_ollama_agents.sh
```

You can also run one agent directly:

```sh
.venv/bin/python examples/ollama_a2a_agent.py --agent assistant --port 5555
.venv/bin/python examples/ollama_a2a_agent.py --agent structured --port 5556
```

## Navigation Agent mock (Ollama-free)

For exercising the inspector's `kind: data` / `ui_tool_call` rendering against
realistic payloads, this folder also ships a hand-rolled mock that mirrors the
production `tto-ida-navigation-agent`:

```sh
uv run python examples/navigation_mock_agent.py
# listens on http://127.0.0.1:5558/
```

It uses no LLM and no Deloitte packages. Behaviour:

- Multi-turn `ui_tool_call` flow with the real selector names
  (`workareaSelector`, `workplanTaskSelector`, `documentSelector`,
  `informationRequestSelector`, `dataPreparationTaskSelector`,
  `analyticReportSelector`, `entitySelector`, ...).
- Each selector call carries a `ui_tool__clarification` preamble plus
  inherited context (`workAreaId`, `etpContainerId`, `client.id`,
  `project.id`, ...) — the same shape as the real agent.
- Once every required parameter is resolved, it emits the final
  `navigation` `ui_tool_call` with `args.url` and marks the task
  `completed`.

Suggested prompts:

| Prompt | Flow |
|---|---|
| `Go to the Reports page` | single-turn → `/reports` |
| `Take me to IDA personalization settings` | single-turn → `/settings/personalization` |
| `Open task` | `workareaSelector` → `workplanTaskSelector` → navigation |
| `Take me to a document` | `workareaSelector` → `documentSelector` → navigation |
| `Show data preparation` | `workareaSelector` → `dataPreparationTaskSelector` → navigation |
| `Navigate me to an information request` | `workareaSelector` → `informationRequestSelector` → nav |
| `Open entity` | `projectSelector` → `entitySelector` → navigation |

Conversation state is keyed by `contextId`, so reply within the same chat
dialog to advance the flow. The mock synthesises deterministic UUIDs for
selected items, so URLs are stable per `(contextId, parameter)` pair.

Override host/port via env vars: `NAV_MOCK_HOST`, `NAV_MOCK_PORT`.
