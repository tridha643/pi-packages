# Repository instructions

- Keep each directory under `packages/` independently loadable as a Pi package.
- Declare each extension entrypoint in that package's `package.json` under `pi.extensions`.
- Keep Pi runtime packages in `peerDependencies` and third-party runtime packages in `dependencies`.
- Do not commit `node_modules`, generated build output, credentials, local state, or absolute user paths.
- Run `npm run verify` from the repository root before publishing changes.
