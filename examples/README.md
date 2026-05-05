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
