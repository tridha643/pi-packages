# Security notes

## Cursor SDK transitive advisory

`@cursor/sdk@1.0.28` depends on `@connectrpc/connect-node@1.7.0`, which depends on `undici@5.29.0`. npm reports high-severity advisories for that Undici version and currently reports no compatible fix through the Cursor SDK dependency tree.

This package requires Node.js 22.13 or newer. In `@connectrpc/connect-node@1.7.0`, Undici is imported to provide `Headers` only on Node.js versions older than 18, so that fallback does not run on supported versions. The dependency remains installed and npm still reports it.

The package intentionally does not force Undici 6 into Connect Node's declared `^5.28.4` range because that creates an invalid dependency tree. Revisit this note when Cursor publishes an SDK using Connect Node 2 or another patched transport.
