# pqs-mcp-server

MCP Server for **PQS (Protocol Quality Standard)** — endpoint verification layer for the AI agent economy.

Exposes 4 tools that any MCP-compatible client (Claude, Cursor, CrewAI, VS Code, Microsoft Agent Framework) can call to verify data providers before paying via x402.

## Tools

| Tool | Description |
|------|-------------|
| `pqs_verify_endpoint` | Check if an endpoint is PQS-verified (call before x402 payment) |
| `pqs_get_certificate` | Retrieve full PQS certificate for a provider |
| `pqs_check_attestation` | Verify response against on-chain EAS attestation |
| `pqs_list_verified_providers` | List all verified providers, filter by capability |

## Install

```bash
npm install pqs-mcp-server
```

Or clone and install locally:

```bash
git clone https://github.com/smartflowproai-lang/pqs-mcp-server.git
cd pqs-mcp-server
npm install
```

## Usage

### Claude Desktop / Claude Code

Add to your MCP config (`.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pqs": {
      "command": "npx",
      "args": ["pqs-mcp-server"],
      "env": {
        "PQS_CA_URL": "http://localhost:4025"
      }
    }
  }
}
```

### Standalone

```bash
PQS_CA_URL=http://localhost:4025 node src/index.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PQS_CA_URL` | `http://localhost:4025` | PQS CA server URL |
| `PQS_TIMEOUT_MS` | `10000` | Request timeout in ms |

## Architecture

```
MCP Client (Claude, CrewAI, etc.)
      |
      | stdio (MCP protocol)
      v
PQS MCP Server (this package)
      |
      | HTTP (JSON)
      v
PQS CA Server (port 4025)
      |
      | EAS attestation
      v
Base L2 (on-chain anchor)
```

## Requirements

- Node.js >= 18 (uses built-in `fetch`)
- PQS CA server running (default `localhost:4025`)

## License

MIT
