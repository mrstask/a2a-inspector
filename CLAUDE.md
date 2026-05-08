# CLAUDE.md

Notes for Claude when working in this repository.

## Developer environment

The maintainer works across two machines, but **Claude only ever has access to the Mac**:

| Machine | Role | What lives here |
|---|---|---|
| **MacBook (local)** | Claude's working machine. All edits, builds, and exploratory testing happen here. | The repo, `uv`, `npm`, an Ollama install with local models, and the example agents in `examples/ollama_a2a_agent.py` (including the keyword-driven `navigation` demo agent on port 5557). |
| **Project VDI (Windows)** | Maintainer-only. Claude has no access. | The real Navigation Agent and the rest of the production-style agents the inspector will ultimately talk to. The maintainer runs final validation here after pulling from `origin/main`. |

### Implications for how we work

1. **Implement and self-test on the Mac.** Every change must be exercised end-to-end locally before being pushed. That means:
   - Build the frontend (`cd frontend && npm run build`) and run the backend (`cd backend && uv run app.py`).
   - When the change touches agent-facing rendering, also start the relevant local example agent and drive it from the inspector UI (or via `curl` JSON-RPC). For `ui_tool_call` rendering this is `uv run python examples/ollama_a2a_agent.py --agent navigation` on port 5557.
   - Run `npm run compile` (tsc) and `npm test` (vitest) before declaring done.
2. **Push to `origin/main` once Mac validation passes.** The maintainer's `origin` is the fork `mrstask/a2a-inspector`. Pushing to `upstream` (`a2aproject/a2a-inspector`) is **not** part of the normal flow — only do it on explicit request.
3. **The maintainer pulls on Windows and re-tests against the real agents.** Any feedback from that pass comes back through this conversation; treat it as the canonical "real-world" verification.
4. **No remote access to Windows.** Don't propose RDP/SSH steps, don't try to inspect the Navigation Agent's source, and don't assume Windows-specific paths or PowerShell quirks unless asked. When Windows-related help is needed, write platform-neutral docs/scripts (`scripts/run.ps1` is the existing PowerShell counterpart to `scripts/run.sh`).
5. **Local Ollama is available.** It's fine to design tests that depend on `OLLAMA_BASE_URL=http://127.0.0.1:11434`, but prefer agents that don't *require* Ollama for protocol-level UI tests (e.g. the `navigation` demo persona is keyword-driven and runs without a model).

### Standard local validation flow for a frontend change

```bash
# 1. build
cd frontend && npm run compile && npm test && npm run build && cd ..

# 2. run inspector
(cd backend && uv run app.py) &

# 3. run whichever example agent exercises the change
uv run python examples/ollama_a2a_agent.py --agent navigation &

# 4. open http://127.0.0.1:5001, add http://127.0.0.1:5557 as a connection,
#    drive the new code paths, take screenshots / note acceptance criteria,
#    then commit + push to origin main.
```

The maintainer then pulls on the Windows VDI and confirms the same behaviour against the real Navigation Agent and any other production agents.

## Repository layout reminders

- `backend/app.py` — FastAPI + python-socketio server, listens on `127.0.0.1:5001`.
- `frontend/src/script.ts` — single-bundle TS app; esbuild emits `frontend/public/script.js`. The bundle is **not** auto-rebuilt by the backend; rebuild manually after edits.
- `frontend/public/styles.css` — all CSS, including the `body.dark-mode` and `body.layout-v2` variants.
- `examples/ollama_a2a_agent.py` — three personas: `assistant`, `structured` (Ollama-backed) and `navigation` (Ollama-free, emits `ui_tool_call` data parts).
- `examples/navigation_mock_agent.py` — high-fidelity mock of the production `tto-ida-navigation-agent` (multi-turn ui_tool_call protocol, real selector names, inherited context args). Listens on `127.0.0.1:5558` by default; no Ollama. Modeled after `~/Projects/deloitte/tto-ida-navigation-agent` (Mac-only, Claude has read access to that repo) — keep it in sync if the real agent's `COMMON_ROUTE_PARAMETERS` or selector list changes.
- `scripts/run.sh` / `scripts/run.ps1` — convenience launchers for Mac/Linux and Windows respectively.

## Conventions

- **No backend changes for UI-only work.** Most rendering tasks are frontend-only; the requirements docs (`REQUIREMENTS_*.md`) call out scope explicitly.
- **Sanitize before `innerHTML`.** Always run agent-controlled strings through `DOMPurify.sanitize()`.
- **Both themes.** New CSS must define both light defaults and `body.dark-mode` overrides.
- **Don't push to `upstream`.** Only `origin` (the maintainer's fork) unless told otherwise.
