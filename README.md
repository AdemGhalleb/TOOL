# Agent Harness TUI

A minimal TypeScript and Ink starter for connecting an agent to a terminal interface.

## Requirements

- Node.js 18 or newer

## Install

```sh
npm install
```

## Configure

Copy the example environment file and add your OpenRouter API key:

```sh
cp .env.example .env
```

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

## Run

```sh
npm run dev
```

Edit the asynchronous `respond` function in `src/index.ts` to connect your own agent. The terminal UI lives in `src/tui/`.

To compile and run the built project:

```sh
npm run build
npm start
```

## Persisted sessions

Conversation history is stored in `.agent-session.json`. The loader treats this
file as untrusted input: it accepts only the message roles and function
tool-call shapes used by the provider, rejects unknown message fields, and
starts a fresh session with a warning if the file is malformed or invalid.
Missing session files retain the normal first-run behavior.

The limits are centralized in `SESSION_LIMITS` in
[`src/session.ts`](./src/session.ts):

- 5 MiB total file size
- 1,000 messages
- 100,000 characters per message content
- 64 tool calls per assistant message
- 1,000 characters per tool-call ID and tool name
- 100,000 characters per tool-call argument string

The file size is checked from metadata before its contents are read, and is
checked again after reading to handle a file that grows during the operation.
Saving validates the messages and writes a temporary file before replacing the
session with a rename. A failed replacement leaves the existing session
untouched. Rename replacement is atomic on platforms where the operating
system supports replacing the destination atomically; the implementation does
not claim stronger cross-platform guarantees.

## Bounded model context

Before each model request, the harness prepares a separate bounded context from
the full in-memory/session history. The default total context budget is 8,192
estimated tokens, with 1,024 tokens reserved for the model response, leaving
7,168 estimated input tokens. A run can override the total and reserved values
through `AgentRunOptions.contextBudget`, or provide `maxInputTokens` directly.

The estimate is deliberately conservative and uses message character lengths
(approximately four characters per token) plus fixed message overhead; it is
not exact tokenizer accounting. System instructions and the latest request are
always retained. Older complete exchanges are dropped first, while assistant
tool calls remain grouped with all corresponding tool results. The persisted
history is not modified. If the system instructions and latest request cannot
fit, or the conversation contains an incomplete tool exchange, the model
request fails with a controlled context-budget error.

The harness does not currently summarize older history automatically, so
semantic compression and provider-specific tokenizers remain follow-up work.
