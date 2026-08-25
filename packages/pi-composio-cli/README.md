# pi-composio-cli

A local Pi package that uses the official Composio CLI as its authentication and execution boundary.

## Requirements

- Pi `>=0.80.10`
- Composio CLI `>=0.2.31`
- A normal `composio login` session

Set `COMPOSIO_CLI_PATH` only when the binary is outside `PATH`, `~/.composio/composio`, or `~/.npm-global/bin/composio`.

## Fixed tools

- `composio_search_tools`
- `composio_get_tool_schemas`
- `composio_multi_execute_tool`
- `composio_manage_connections`
- `composio_wait_for_connections`
- `composio_remote_workbench`
- `composio_remote_bash_tool`
- `composio_execute_tool`
- `composio_list_connections`
- `composio_proxy`

Search and schema lookup register ordinary Composio tools dynamically, then activate them additively for the current Pi session. The loaded schemas are restored from Pi custom session entries after resume.

Recipe operations are intentionally absent from the first-class, generic, multi-execute, and dynamic-tool surfaces. Direct recipe references are also rejected in remote code, but the requested workbench and bash tools execute arbitrary user code and are not a hostile-code security sandbox.

## Commands

- `/composio-login`
- `/composio-whoami`
- `/composio-link <toolkit> [account-alias]`
- `/composio-connections [toolkit]`
- `/composio-reset-tools`
- `/composio-doctor`

The extension never reads Composio credential files. JSON tool arguments are written to CLI stdin so they do not appear in the process argument list.

## Development

```bash
npm install
npm run verify
```
