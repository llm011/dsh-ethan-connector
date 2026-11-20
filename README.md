# dsh-ethan-connector

DeepSeek Harness (DSH) bundle that connects DSH with **Ethan Agent** and session-aware upstream gateways (such as `buddy-proxy`).

## Capabilities

1. **Automatic `x-session-id` header injection (`llm-pi-ai/request-headers`)**
   - Listens to `@deepseek-ai/dsh-llm-pi-ai`'s `llm-pi-ai/request-headers` waterfall event and sets `x-session-id` from `request.sessionId` (unless the request already supplies `x-session-id`).
   - Enables downstream proxies like `buddy-proxy` to route each DSH session consistently to the same upstream account while rotating new sessions across accounts.

2. **`ethan_run` tool (`ethan acp` bridge, TUI & Web compatible)**
   - Registers the `ethan_run` tool when the `tools` service is mounted.
   - Invokes `ethan acp` over JSON-RPC stdio, supporting new sessions and continuing existing sessions via `session_id` (`session/load`).
   - Captures executed tool steps (`tool_call` / `tool_call_update`) and Ethan's reply, rendering them through DSH's standard `presentCall` / `presentResult` `GenericCallView` & `GenericResultView` contracts so both **DSH TUI** and **DSH Web** display clean step summaries.

## Configuration (`cordis.patch.yml`)

```yaml
- id: ethan-connector
  name: 'dsh-ethan-connector'
  config:
    injectSessionHeader: true   # default: true
    enableTool: true            # default: true
    ethanCommand: ethan         # optional override for ethan executable path
    ethanArgs: ['acp']          # optional override for args
    autoApprove: true           # default: true (auto-approve ACP permission prompts)
    timeoutMs: 600000           # default: 10 minutes
```

## Notes

- Only `llm-pi-ai` provider routes (custom/third-party endpoints such as `buddy-proxy`) emit `llm-pi-ai/request-headers`; built-in DeepSeek official routes do not use `pi-ai`.
- Intermediate Ethan tool steps are collected during the ACP run and rendered together in the settled `presentResult` card (DSH's TUI tool pipeline renders settled tool results rather than incremental `tool.progress` frames).
