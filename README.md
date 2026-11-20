# dsh-ethan-connector

DeepSeek Harness (DSH) bundle that connects DSH with **Ethan Agent** and session-aware upstream gateways (such as `buddy-proxy`).

## Capabilities

1. **Automatic `x-session-id` header injection (`llm-pi-ai/request-headers`)**
   - Listens to `@deepseek-ai/dsh-llm-pi-ai`'s `llm-pi-ai/request-headers` waterfall event and sets `x-session-id` from `request.sessionId` (unless the request already supplies `x-session-id`).
   - Enables downstream proxies like `buddy-proxy` to route each DSH session consistently to the same upstream account while rotating new sessions across accounts.

2. **`ethan_run` tool (HTTP-first, ACP fallback; TUI & Web compatible)**
   - Registers the `ethan_run` tool when the `tools` service is mounted.
   - **HTTP transport (default when available)**: calls the running Ethan server's `/api/chat` SSE endpoint (default `http://127.0.0.1:8900`), reusing its configured models, memory, and tools. The `auth_token` is read automatically from `~/.ethan/config.yaml` (override with `authToken` config or `ETHAN_AUTH_TOKEN`). Supports continuing an existing session via `session_id`.
   - **ACP fallback**: when no HTTP server is reachable, spawns `ethan acp` over JSON-RPC stdio (`session/new` / `session/load` / `session/prompt`).
   - Captures executed tool steps and Ethan's reply, rendering them through DSH's standard `presentCall` / `presentResult` `GenericCallView` & `GenericResultView` contracts so both **DSH TUI** and **DSH Web** display clean step summaries.

## Configuration (`cordis.patch.yml`)

```yaml
- id: ethan-connector
  name: 'dsh-ethan-connector'
  config:
    injectSessionHeader: true   # default: true
    enableTool: true            # default: true
    transport: auto             # auto | http | acp (default: auto — HTTP if reachable, else ACP)
    ethanUrl: http://127.0.0.1:8900  # Ethan HTTP server base URL (or ETHAN_URL env)
    authToken: ''               # optional; defaults to auth_token in ~/.ethan/config.yaml
    ethanConfigPath: ''         # optional path to Ethan config.yaml
    ethanCommand: ethan         # ACP fallback: ethan executable path (or ETHAN_BIN env)
    ethanArgs: ['acp']          # ACP fallback: args
    autoApprove: true           # default: true (auto-approve tool permissions)
    timeoutMs: 600000           # default: 10 minutes
```

## Notes

- Only `llm-pi-ai` provider routes (custom/third-party endpoints such as `buddy-proxy`) emit `llm-pi-ai/request-headers`; built-in DeepSeek official routes do not use `pi-ai`.
- Intermediate Ethan tool steps are collected during the ACP run and rendered together in the settled `presentResult` card (DSH's TUI tool pipeline renders settled tool results rather than incremental `tool.progress` frames).
