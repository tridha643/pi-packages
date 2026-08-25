# pi-output-style

Switch Pi’s writing guidance from Markdown files without changing engineering, verification, or safety rules.

Put global styles in `~/.pi/agent/output-styles/*.md`, or project styles in `.pi/output-styles/*.md`; a project style with the same filename wins. Use `/output-style` to pick one, `/output-style <slug>` to set it globally, `/output-style <slug> --project` to pin it to the current project, and `pi --output-style <slug>` for a session-only override.

The extension stores selections in `~/.pi/agent/output-style.json` and injects the active style before every agent turn.

## Development

```sh
npm install
npm run check
```
