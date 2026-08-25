# pi-tool-search

Keeps a personal Pi baseline active, then exposes `search_tools` to load registered tools by capability for the rest of the session.

The extension deliberately retains its personal catalog: editing, memory, single and parallel delegation, task labels, browser and computer-use families, Modem lookup, and the aliases that make those tools discoverable. It does not attempt to invent a generic catalog from installed package metadata.

## Commands

- `/tool-search-status` reports the registered active and inactive tools.
- `/tool-search-reset` removes lazily loaded tools and restores the session baseline.

At `session_start`, the extension respects explicit Pi `--tools` and `--no-tools` choices by intersecting the baseline with the currently active tools. It prunes again before the first agent request because later startup handlers can reactivate tools.

## Development

```bash
npm install
npm run check
npm test
```
