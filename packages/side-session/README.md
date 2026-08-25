# pi-side-session

Opens a Pi session in a right-hand Herdr pane and returns its final summary to the parent session.

## Requirements

- Pi `>=0.80.10`, launched inside Herdr.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_TAB_ID` must be present. Herdr normally supplies them; outside Herdr, `/side` reports an error and does nothing.
- The `herdr` command must be on `PATH`, unless `HERDR_BIN_PATH` points to it.

Use `/side [prompt]` to open a cloned session. In the side pane, invoke `/side-end [notes]`; the agent must then call `complete_side_session` once to deliver the handoff and close the pane.

## Environment overrides

- `HERDR_BIN_PATH` changes the `herdr` executable used to start, message, and close panes.
- `PI_HERDR_PI_BIN` changes the Pi executable launched in the side pane; it defaults to `pi`.

The extension passes the parent pane ID, branch entry ID, and source session path to the side pane through its own `PI_SIDE_*` environment variables. Those variables are lifecycle state, not user configuration.

## Development

```bash
npm install
npm run check
npm test
```
