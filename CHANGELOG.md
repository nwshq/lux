# 1.0.0 (2026-03-14)


### Bug Fixes

* bump CI and release workflows to Node 22 ([e76e86d](https://github.com/nwshq/lux/commit/e76e86df3c786318f227ae80f99946cc24be23c2))
* exclude web PoC from architecture tests ([cb88dc1](https://github.com/nwshq/lux/commit/cb88dc1dab349da0378a4117a6031ef5cdfca582))
* exclude web PoC from lint/CI and clean up stale eslint directives ([796739d](https://github.com/nwshq/lux/commit/796739d206fc6e155c542413ece44b1859a1d358))
* **experts:** isolate subprocess env from parent context ([d35c0e3](https://github.com/nwshq/lux/commit/d35c0e3eaa73b60e5b7a5e0cd2e2c57ceabae1bd))
* **experts:** use spawn-based session manager for CLI ask, fix --resume lifecycle ([20d8b83](https://github.com/nwshq/lux/commit/20d8b8370d63249069198bac93f5f3f931dad35c))
* gitignore .next build cache and .env.local ([99c22cb](https://github.com/nwshq/lux/commit/99c22cb24e72a7a5c361abbe817606f460ab7beb))
* resolve TypeScript build errors in lint types and frontmatter utils ([87e8f0d](https://github.com/nwshq/lux/commit/87e8f0d1a6d53aa085dfb2f7a5eb7e7f191eaf0c))
* **sync:** scope LSP enrichment to changed files only (17s → 1s) ([baebd2b](https://github.com/nwshq/lux/commit/baebd2b41acd4000e46d77cac10347934f039e9d))


### Features

* add semantic-release with GitHub Release tarball distribution ([06c17f8](https://github.com/nwshq/lux/commit/06c17f8f96527ad9664767fbb05ad2032a148d03))
* Architecture-First Standards compliance ([#2](https://github.com/nwshq/lux/issues/2)) ([d06b1d2](https://github.com/nwshq/lux/commit/d06b1d27c00095e780ae18c955823ee5ac4ba231))
* **cli:** add `lux ask` command with expert routing and JSON/verbose output ([c3032c4](https://github.com/nwshq/lux/commit/c3032c46183b00a1778cd6d3a775cf93294110cf))
* **cli:** add expert registry with list, show, add, remove subcommands ([c6119ee](https://github.com/nwshq/lux/commit/c6119ee84cf22455ee15208d09704be73965cfa9))
* **cli:** wire init, docs, exploration, and journal commands ([86b24cc](https://github.com/nwshq/lux/commit/86b24cc461ff31ec5cea46e2a9b0b77a309a35a6))
* **cli:** wire LSP enrichment into rebuild, add --accept-all to discover ([89e1535](https://github.com/nwshq/lux/commit/89e1535a377eda0a24b8bc864b4fee098725a3f4))
* **experts:** add ExpertSessionManager interface and implementation ([b4c85fd](https://github.com/nwshq/lux/commit/b4c85fd4429e1acf42ce76306561f9f1125890e8))
* **experts:** add LLM-based expert routing via Haiku ([95613a0](https://github.com/nwshq/lux/commit/95613a009b7ce883b94fdff14859d1798ea5cfbc))
* **experts:** add query router with FTS5 search-based expert matching ([cef4826](https://github.com/nwshq/lux/commit/cef4826df8f2db8df54676d312420c39c87a8086))
* **experts:** add RAG context enrichment for expert queries ([f405550](https://github.com/nwshq/lux/commit/f405550f078b38a20a7d38bf567467a95794775e))
* **experts:** add routing telemetry events for analysis and tuning ([54f155b](https://github.com/nwshq/lux/commit/54f155b11340e85b1ed28d54c83e9355ab19501e))
* **experts:** add streaming support for expert responses via onChunk callback ([f385f74](https://github.com/nwshq/lux/commit/f385f743d64e48b7407a8a41985b70a1d1182b8d))
* **experts:** add SubprocessSessionManager with Claude CLI subprocess lifecycle management ([ca965c3](https://github.com/nwshq/lux/commit/ca965c34395ea58aecaa761cc203a0028efa7399))
* **index:** add incremental sync command with git-based change detection ([bec4d2e](https://github.com/nwshq/lux/commit/bec4d2e432933d3663120bb81833065d802ccf18))
* **lint:** add location rules for artifacts ([ba29708](https://github.com/nwshq/lux/commit/ba2970837fde193753148cca85fb65cfdc3b9e5b))
* **lint:** detect cross-cutting explorations at CORPUS root as info ([60dcd12](https://github.com/nwshq/lux/commit/60dcd121bb79ce7de314215cf3f82b805549269c))
* **lint:** register payload-corpus-location rule in lint engine ([597275a](https://github.com/nwshq/lux/commit/597275ae1fc49ae8e7ff95e10371634fd8a7aa34))
* **lux-knowledge-platform:** functional MCP server with CORPUS scanner and CLI ([b2ad1f3](https://github.com/nwshq/lux/commit/b2ad1f32e4316445932601283af6d10fa9beb8dd))
* **mcp:** add lux_list_experts and lux_ask tools to MCP server ([d418258](https://github.com/nwshq/lux/commit/d4182586347fae27111872ba07a13c51aa137572))
* **mcp:** update lux_ask tool to match spec with auto-routing and structured output ([bfe458f](https://github.com/nwshq/lux/commit/bfe458f4ee2acc38b61063da87d7538f32702464))
* **scanner:** add source code file scanning alongside markdown ([50c4764](https://github.com/nwshq/lux/commit/50c47643ad9483df6c310dd57031d95094eb9b64))
* **scanner:** scan project directories for explorations/ and payloads/ subdirs ([550ec3c](https://github.com/nwshq/lux/commit/550ec3c0876dce5e3d9a93a3d34156de622e6db4))
* **web:** add Next.js web UI for expert panel interaction ([7087db5](https://github.com/nwshq/lux/commit/7087db5a195a767f9e8c4a35e52ad2584869857c))
