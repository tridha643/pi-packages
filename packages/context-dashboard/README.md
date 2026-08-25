# pi-context-dashboard

Pi header art and a responsive footer showing the active model, context-window usage, repository state, and extension statuses.

## Optional dashboard events

The dashboard works without companion extensions. It initially shows unknown model and repository details, then listens for these optional Pi event channels:

- `dashboard:model-info` supplies model, context-window, cost, and throughput data.
- `dashboard:git-info` supplies branch, changed-file, and pull-request data.
- `dashboard:refresh` is emitted after the dashboard installs so publishers can resend their current state.

Invalid event payloads are ignored, so publishers can evolve independently as long as they retain the documented shapes in `dashboard-state.ts`.

## Development

```sh
npm install
npm run check
npm test
```
