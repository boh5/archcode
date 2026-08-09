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

Custom MCP servers are configured under `mcp.servers` in the server-wide
`~/.archcode/config.json`. Every entry must include both `type` and `enabled`.
The two supported transports are Streamable HTTP and STDIO:

```json
{
  "mcp": {
    "disabledBuiltins": ["grep.app"],
    "servers": {
      "internal-docs": {
        "type": "http",
        "enabled": true,
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer ${MCP_TOKEN}"
        },
        "connectTimeoutMs": 10000,
        "discoveryTimeoutMs": 30000,
        "callTimeoutMs": 60000
      },
      "local-tools": {
        "type": "stdio",
        "enabled": false,
        "command": "my-mcp-server",
        "args": ["--stdio"],
        "env": {
          "MCP_PROFILE": "local"
        }
      }
    }
  }
}
```

`connectTimeoutMs`, `discoveryTimeoutMs`, and `callTimeoutMs` are optional
positive integer deadlines. Their defaults are 10,000 ms (connect), 30,000 ms
(tools/list discovery), and 60,000 ms (tools/call). The legacy single `url`,
`headers`, and `timeout` object is not accepted.

HTTP URLs and header values, and STDIO environment values, support `${VAR}` and
`${VAR:-default}` expansion. STDIO `command` and `args` are passed literally;
ArchCode does not add a shell, project `cwd`, or command interpolation layer.
Keep tokens in the environment rather than writing expanded secret values into
source-controlled files.

Built-in servers (`context7`, `grep.app`, and `exa`) are fixed by ArchCode and
cannot be replaced by a user server with the same name. `disabledBuiltins`
only disables a listed built-in.

Configured user MCP servers are process-global and live. All six Agent
identities see the current user-server descriptors at their next model-call
boundary; there is no user-server role filter and no additional approval step
for an MCP call. The built-in role matrix is unchanged:

| Agent | Built-in MCP servers |
| --- | --- |
| Lead | `context7`, `exa` |
| Discussion | none |
| Analyst | `context7` |
| Build | none |
| Explore | none |
| Librarian | `context7`, `grep.app`, `exa` |

This matrix only limits built-ins. A local read-only Agent can still invoke a
user MCP tool that writes to an external system; local read-only tools do not
make an external MCP side effect read-only.

Saving in **Settings → MCP** validates and atomically writes the complete
Config, then hot-applies the resolved MCP configuration when Runtime is ready.
The Settings panel and global status API expose `disabled`, `connecting`,
`ready`, and `failed` states, discovered tool inventory, a draft **Test** action,
and **Reconnect** for an existing server. A failed live apply does not undo the
already committed Config; Settings reports the independent apply failure so you
can retry or reconnect.
