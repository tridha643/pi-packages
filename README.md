# Pi packages

Personal Pi extension packages kept together in one private repository. Each folder under `packages/` is a standalone Pi package. The root package loads all of them together.

## Packages

- `blue-gradient-editor`
- `cache-health`
- `context-dashboard`
- `output-style`
- `side-session`
- `tool-search`
- `pi-agent-delegation`
- `pi-composio-cli`

## Install all packages

```bash
pi install git:git@github.com:tridha643/pi-packages.git
```

## Use one package from a local clone

```bash
pi install /absolute/path/to/pi-packages/packages/tool-search
```

Pi does not document a Git subdirectory source syntax. The repository root is the Git-installable package; each child remains independently installable from a local clone.

## Development

```bash
npm install
npm run verify
```
