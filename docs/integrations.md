# GitHub and MCP integrations

Integrations are optional. Configure them in the server-wide
`~/.archcode/config.json`.

## GitHub

Enable GitHub support with an environment-backed token:

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "tokenEnv": "ARCHCODE_GITHUB_TOKEN"
    }
  }
}
```

Set the named environment variable before starting ArchCode. Do not put a raw
GitHub token in the JSON integration object.

When no explicit `tokenEnv` value resolves, ArchCode can use `GITHUB_TOKEN` and
then `GH_TOKEN` as fallbacks. `GITHUB_TOKEN` wins when both are set.

## Custom MCP servers

Custom MCP servers use the current HTTP configuration shape:

```json
{
  "mcp": {
    "servers": {
      "internal-docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer ${MCP_TOKEN}"
        },
        "timeout": 30000
      }
    }
  }
}
```

MCP URLs and headers support `${VAR}` and `${VAR:-default}` environment
expansion. Keep tokens in the environment rather than writing expanded secret
values into source-controlled files.

The current custom-server shape is HTTP-only and does not use a transport
selector. MCP changes require the restart reported by Settings.
