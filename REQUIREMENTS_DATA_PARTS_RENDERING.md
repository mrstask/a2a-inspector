# Requirements: Render `kind: "data"` / `ui_tool_call` Parts in the Chat UI

## Background

The A2A Inspector chat view currently renders only `kind: "text"` message parts.
Agents that use client-side UI tool calls (e.g. the IDA Navigation Agent) reply with
`kind: "data"` parts whose `data.type` is `"ui_tool_call"`.  These payloads are never
shown as meaningful chat bubbles — the user sees only lifecycle noise such as
*"task Task created with status: submitted"*.

### Example payload (Navigation Agent — route resolved)

```json
{
  "kind": "data",
  "data": {
    "type": "ui_tool_call",
    "data": {
      "name": "navigation",
      "args": { "url": "/work-areas/37787232-b8c3-4846-a3bc-30b3687c088e/data-preparation" }
    }
  }
}
```

### Example payload (Navigation Agent — awaiting user selection)

```json
{
  "kind": "data",
  "data": {
    "type": "ui_tool_call",
    "data": {
      "name": "dataPreparationTaskSelector",
      "args": {}
    }
  }
}
```

---

## Goals

1. Show `kind: "data"` / `ui_tool_call` parts as **styled, human-readable chat bubbles** instead of raw JSON or silence.
2. Distinguish visually between the two principal sub-types:
   - **Navigation call** — the agent has resolved a URL and is asking the UI to navigate there.
   - **Selector call** — the agent is paused, waiting for the user to pick an item via a UI widget.
3. Keep backward compatibility: all existing `kind: "text"`, `kind: "file"`, and unrecognised `kind: "data"` payloads must continue to render exactly as before.
4. No backend (`app.py`) changes required; this is a **frontend-only** change.

---

## Scope

| Area | In scope |
|---|---|
| `frontend/src/script.ts` — `processPart()` | **Yes** — add `ui_tool_call` branch |
| `frontend/src/script.ts` — `AgentResponseEvent` type | **Yes** — widen `parts` type to include data parts |
| `frontend/src/script.ts` — `status-update` handler | **Yes** — process data parts, not only `parts[0].text` |
| CSS / design tokens | **Yes** — new bubble variants |
| `index.html` | No structural change needed |
| Backend `app.py` | **No** |
| A2A SDK types | **No** |

---

## Functional Requirements

### FR-1  Type widening

The `AgentResponseEvent` TypeScript interface currently declares `status.message.parts`
as `{text?: string}[]`.  It must be widened to accept data parts at compile time:

```typescript
// Before
status?: {
  state: string;
  message?: { parts?: { text?: string }[] };
};

// After
type AnyPart =
  | { kind?: string; text?: string }
  | { kind?: string; file?: FileContent }
  | { kind?: string; data?: unknown };

status?: {
  state: string;
  message?: { parts?: AnyPart[] };
};
```

The same widening should be applied to `event.parts` (used by the `"message"` handler).

### FR-2  `processPart()` — `ui_tool_call` branch

Inside `processPart()`, **before** the generic `p.data` fallback, add a branch that
detects `data.type === "ui_tool_call"` and delegates to a dedicated renderer:

```
processPart(p):
  if p.text            → existing markdown renderer
  if p.file            → existing media renderer
  if p.data:
    if p.data.type === "ui_tool_call":   ← NEW
      return renderUiToolCall(p.data.data)
    else:
      → existing raw JSON <pre><code> fallback (unchanged)
```

### FR-3  `renderUiToolCall(tool)` — navigation sub-type

When `tool.name === "navigation"` and `tool.args.url` is present, render a
**Navigation Pill**:

- Icon: `→` or a small arrow/link SVG
- Label: `Navigate to`
- Value: the URL displayed as monospace text, optionally as a clickable `<a href>` (target `_blank`)
- Visual style: blue/teal accent — clearly positive / resolved outcome
- Accessible `aria-label`: `"Navigation: <url>"`

Example rendered output:

```
┌─────────────────────────────────────────────┐
│  →  Navigate to                              │
│     /work-areas/.../data-preparation         │
└─────────────────────────────────────────────┘
```

### FR-4  `renderUiToolCall(tool)` — selector sub-type

When `tool.name` is **anything other than `"navigation"`**, render an
**Awaiting Input Badge**:

- Icon: `⏳` or a pause/input SVG
- Label: `Awaiting input`
- Value: the `tool.name` in human-readable form (e.g. `"dataPreparationTaskSelector"` → `"Data Preparation Task Selector"`)
- Visual style: amber/orange accent — signals the conversation is paused
- Tooltip / `title`: full raw tool name for developer reference
- Accessible `aria-label`: `"Awaiting input: <tool name>"`

Example rendered output:

```
┌──────────────────────────────────────────┐
│  ⏳  Awaiting input                       │
│      Data Preparation Task Selector       │
└──────────────────────────────────────────┘
```

### FR-5  `status-update` handler — data-part support

The current `status-update` branch reads only `parts?.[0]?.text` and silently drops
non-text parts. Replace this with `collectPartsContent(event.status?.message?.parts)`,
matching the pattern already used in the `task` branch.

```typescript
// Before
const statusText = event.status?.message?.parts?.[0]?.text;
if (statusText) { ... render markdown ... }

// After
const statusContent = collectPartsContent(event.status?.message?.parts);
if (statusContent.length > 0) {
  appendMessage('agent progress', statusContent.join(''), ...);
}
```

### FR-6  `input-required` state indicator

When `event.status?.state === "input-required"`, append a small badge next to the
message in the chat list (in addition to the `kind-chip` already present for other
states):

- Text: `input required`
- Style: same amber as the Awaiting Input Badge (FR-4)
- Purpose: makes the paused-conversation state immediately visible without having to
  open the raw JSON modal

### FR-7  Unknown `ui_tool_call` name — graceful fallback

If `tool.name` is not `"navigation"` and not a known selector, still render the
Awaiting Input Badge (FR-4) using the raw `tool.name` value.  Never silently drop the
part.

### FR-8  Raw JSON modal — unchanged

Clicking a message bubble still opens the existing raw JSON modal with the full event
payload.  The new rendered pill is **additive** — it does not replace the click-to-view
behaviour.

---

## Non-Functional Requirements

### NFR-1  Security

All user-controlled strings (URL, tool name, args values) must be passed through
`DOMPurify.sanitize()` before being written to `innerHTML`.

### NFR-2  Accessibility

New elements must include appropriate `role`, `aria-label`, and keyboard-focusable
affordances consistent with the existing inspector UI.

### NFR-3  Theme support

The new pill/badge CSS must define colours for both the existing **light** and
**dark** (`body.dark-mode`) themes.

### NFR-4  No layout regressions

The new bubbles must not break the existing chat scroll behaviour, message-details
popover, or validation status indicator.

---

## Implementation Hints (not prescriptive)

### Helper: camelCase → human label

```typescript
function camelToLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}
// "dataPreparationTaskSelector" → "Data Preparation Task Selector"
```

### Suggested CSS classes

| Class | Purpose |
|---|---|
| `.part-tool-call` | Shared wrapper for all ui_tool_call pills |
| `.part-tool-call--navigation` | Blue/teal navigation variant |
| `.part-tool-call--selector` | Amber awaiting-input variant |
| `.part-tool-call__icon` | Leading icon |
| `.part-tool-call__label` | "Navigate to" / "Awaiting input" |
| `.part-tool-call__value` | URL or human-readable selector name |
| `.kind-chip-input-required` | State chip for `input-required` (FR-6) |

### Where to add the branch in `processPart`

```typescript
// script.ts — processPart(), around line 1405
} else if (p.data) {
  const dataObj = p.data as { type?: string; data?: { name?: string; args?: Record<string, unknown> } };
  if (dataObj.type === 'ui_tool_call' && dataObj.data) {
    return renderUiToolCall(dataObj.data);   // ← new
  }
  // existing fallback
  return `<pre><code>${DOMPurify.sanitize(JSON.stringify(p.data, null, 2))}</code></pre>`;
}
```

---

## Acceptance Criteria

| # | Scenario | Expected result |
|---|---|---|
| AC-1 | Navigation Agent returns a resolved route URL | Chat shows a blue Navigation Pill with the URL |
| AC-2 | Navigation Agent is waiting for `workareaSelector` | Chat shows an amber Awaiting Input Badge with "Workarea Selector" |
| AC-3 | Navigation Agent is waiting for `dataPreparationTaskSelector` | Chat shows an amber Awaiting Input Badge with "Data Preparation Task Selector" |
| AC-4 | Task state is `input-required` | An `input required` amber chip appears on the bubble |
| AC-5 | Clicking any new bubble | Existing JSON modal opens with full event payload |
| AC-6 | Agent sends a `kind: "text"` part | Unchanged markdown rendering |
| AC-7 | Agent sends an unrecognised `kind: "data"` (not `ui_tool_call`) | Unchanged raw `<pre><code>` fallback |
| AC-8 | Dark mode toggled | New pills use dark-mode colour variants, no contrast issues |
| AC-9 | `status-update` event with a data part | Part is rendered (was previously silently dropped) |
