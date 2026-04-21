# Lux AI configuration

Lux now resolves its main AI/runtime defaults from a shared environment-aware layer.

## Environment variables

### Base defaults

- `LUX_MODEL`
- `LUX_BACKEND` (`claude` or `pi`)
- `LUX_PROVIDER`
- `LUX_THINKING` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)

These act as the default AI configuration for:
- discovery analysis
- expert registration defaults
- expert runtime defaults
- `lux init`
- CLI defaults where no explicit flag is provided

### Synthesis overrides

- `LUX_SYNTHESIS_MODEL`
- `LUX_SYNTHESIS_BACKEND`
- `LUX_SYNTHESIS_PROVIDER`
- `LUX_SYNTHESIS_THINKING`

These override only discovery synthesis behavior.

### Routing overrides

- `LUX_ROUTING_MODEL`
- `LUX_ROUTING_BACKEND`
- `LUX_ROUTING_PROVIDER`
- `LUX_ROUTING_THINKING`

These override panel routing / LLM routing selection behavior.

### Path/runtime env

- `LUX_CORPUS_PATH`
- `LUX_DB_PATH`

## Default behavior

If no Lux-specific env vars are set:
- model defaults to `gpt-5.4`
- backend defaults to `pi`
- provider defaults to `openai` for Pi-backed paths
- thinking defaults to `high` for Pi-backed paths

If a model string clearly implies Claude, Lux still infers Claude when backend is omitted, for example:
- `claude-sonnet-*`
- `anthropic/...`

## CLI overrides

Explicit CLI flags still take precedence over env defaults.

Important examples:
- `lux expert add --model --backend --provider --thinking`
- `lux expert discover --model --backend --provider --synthesis-* --thinking`
- `lux ask --routing-model --routing-backend --routing-provider --routing-thinking`

## Compatibility note

Claude is still supported. Lux is now backend-aware and Pi-first across the main AI surfaces, but legacy Claude-backed records and explicit Claude configuration continue to work.
