# Implementation Notes: Lux Knowledge Platform

---

## Decisions

- **File-first:** Index stores metadata only. AI reads files directly for content.
- **No real-time:** Eventually consistent. Index rebuilds on git changes.
- **MCP-native:** Primary interface for AI consumption. CLI for humans.
- **SQLite:** Single file database, portable, no server.

---

## Blockers

*(None yet)*

---

## Dependencies

- CORPUS exists and follows current structure
- Node.js 20+
- mcporter for MCP testing

---

## CORPUS Structure Reference

```
CORPUS/
├── knowledge/
│   ├── 10_clients/
│   │   ├── {client-slug}/
│   │   │   ├── README.md           # Client overview
│   │   │   ├── BACKLOG.md          # Optional
│   │   │   ├── communications/     # Communication files
│   │   │   │   └── YYYY-MM-DD_*.md
│   │   │   └── {project-slug}/     # Project directory
│   │   │       └── README.md
│   ├── 20_methodology/
│   ├── 30_specs/
│   └── ...
├── explorations/
├── implementation-payloads/
└── memory/
```

---

## Scanner Heuristics

**Client detection:**
- Directory in `knowledge/10_clients/`
- Has README.md

**Project detection:**
- Subdirectory of client (not `communications/`, `_meta/`)
- Has README.md

**Communication detection:**
- File in `communications/` directory
- Filename pattern: `YYYY-MM-DD_*.md`

**Knowledge detection:**
- Any .md file outside communications/
- Type inferred from frontmatter or path

---

## Deviations from Exploration

*(Note any changes during implementation)*

---
