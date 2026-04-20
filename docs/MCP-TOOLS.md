# MCP Tools

Current MCP tool surface from `src/mcp/server.ts`.

## Live tools

- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_list_experts`
- `lux_ask`

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
