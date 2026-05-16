# MCP Tools

Current MCP tool surface from `src/mcp/server.ts`.

## Live tools

- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_list_experts`
- `lux_ask`
- `lux_spec_derivation_evidence`

## `lux_search`

```json
{
  "query": "string",
  "type": "all|knowledge",
  "limit": 20
}
```

## `lux_log_event`

```json
{
  "source": "string",
  "event_type": "string",
  "summary": "string",
  "payload": {}
}
```

## `lux_get_file`

```json
{
  "file_path": "string"
}
```

## `lux_rebuild_index`

```json
{}
```

## `lux_list_experts`

```json
{
  "status": "active|inactive|all"
}
```

## `lux_ask`

```json
{
  "question": "string",
  "expert_hint": "string",
  "context": "string"
}
```

## `lux_spec_derivation_evidence`

Returns a `SpecDerivationEvidencePacketV1` JSON packet for a single route, handler, job, listener, or command target. This is source evidence for downstream specification derivation, not a Lux-authored specification.

```json
{
  "question": "what source evidence supports this operation?",
  "target": "POST /orders/{id}/cancel",
  "kind": "route"
}
```

Supported `kind` values: `route`, `handler`, `job`, `listener`, `command`.

Deferred seed kinds such as `event`, `service`, `region`, file, and symbol are not accepted in this tranche. The tool returns the same packet contract as CLI `lux overlay spec-evidence ask --json`; unresolved or ambiguous targets are returned as MCP errors.

## Usage observability

MCP search, rebuild, ask, and spec-evidence paths emit normalized local `lux_usage_event` records where the handler has enough context to do so. These events are written to the same repo-local SQLite event store used by CLI observability and can be reviewed with `lux usage report` from the CLI. External event shippers are not part of this tranche.
