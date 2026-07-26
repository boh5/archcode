# Local and remote deployment

ArchCode always runs as a server with a Web UI. The server can be on the same
machine as your browser or on another machine you control.

## Local use

Start ArchCode:

```sh
archcode
```

Open `http://localhost:4096`. Choose another port with:

```sh
archcode --port 5096
```

`--port` takes precedence over `ARCHCODE_PORT`. Startup fails with an
actionable error when the selected port is already in use.

The Release installer installs only the executable. It does not create a
launchd, systemd, or other background service. Closing the ArchCode process or
turning off the machine stops the runtime.

## Workstation, home server, or VPS

The same binary can run on an always-on workstation, Mac mini, home server, or
VPS. Registered project directories must already exist on that machine.

For any non-local deployment:

1. Enable **Require login** during Setup, or configure a password later in
   **Settings → Security**.
2. Put ArchCode behind HTTPS or a trusted reverse proxy.
3. Restrict network access to people who should be able to operate the
   registered workspaces.
4. Run one ArchCode server process as the writer for a registered project.
5. Keep the process under a supervisor you understand if it must remain online.

ArchCode can continue an active Execution after a browser disconnects as long
as its process and machine remain running. In the current release, restarting
the server interrupts an active Execution; persisted Session history remains
available after restart. Direct-update restart is consequently accepted only
when all Runtime Session families and control operations are idle.

## Reverse proxy requirement

Preserve the browser's original `Host` header. ArchCode deliberately does not
trust `X-Forwarded-*`. For Nginx:

```nginx
proxy_set_header Host $http_host;
```

If a proxy replaces `Host` with its upstream address, same-origin Setup, login,
and mutation requests fail with `403`.

## Server settings

| Variable | Default | Description |
|---|---|---|
| `ARCHCODE_PORT` | `4096` | Server port. `--port` takes precedence. |
| `ARCHCODE_LOG_LEVEL` | `info` | Minimum structured log level: `debug`, `info`, `warn`, or `error`. |
| `ARCHCODE_ACCESS_LOG` | `on` | Enables or disables HTTP access records. |
| `ARCHCODE_HOST` | unset | Externally advertised host for deployments or clients that need it. |
| `ARCHCODE_OPEN_BROWSER` | unset | Reserved for opening the Web UI automatically at boot. |
| `ARCHCODE_PROJECTS_DIR` | unset | Base directory used by project-selection flows. |
| `GITHUB_TOKEN` | unset | First GitHub token fallback when the integration is configured. |
| `GH_TOKEN` | unset | Secondary GitHub token fallback. |

HTTP `2xx`, `3xx`, and `4xx` access records are Info events; `5xx` records are
Error events. Disable only request records while keeping other Info logs:

```sh
ARCHCODE_ACCESS_LOG=off archcode
```

Invalid logging values fail startup before the runtime is initialized.

Read [security and trust boundaries](security.md) before exposing ArchCode
outside a trusted machine or network.
