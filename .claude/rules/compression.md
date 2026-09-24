---
paths:
  - "main.ts"
  - "server/compression.ts"
---

# Compression middleware

**`compression()` in `main.ts` is the outermost middleware, and that position is
load-bearing.** Nothing compressed before it: `staticFiles()` serves the built
bundles verbatim, so `deno task start` shipped the 409 KB protected-data chunk,
the 79 KB stylesheet and the 152 KB Leaflet bundle at full size — and because
the gate makes both the HTML and that chunk `no-store`, every navigation paid
again. Compressing outside `protectDataAssets()` is what lets it cover the
protected chunk that middleware rewrites. It skips anything already carrying
`Content-Encoding`, so an edge that compresses cannot double-encode; it skips
fonts and images, which are already compressed containers; and it suffixes the
`ETag`, because the gzip body is a different representation from the one
`staticFiles()` tagged. Measured, every route dropped from 760–1000 KB to
204–255 KB. It steps aside in development mode: under Vite the gzip body arrived
corrupt and Chromium never reached `load`. `ctx.config.mode` alone cannot tell
it that: `@fresh/plugin-vite`'s generated server entry hardcodes `"production"`
into `setBuildCache` for `deno task dev` as well as the build, so
`server/compression.ts` also reads Vite's own `import.meta.env.DEV`, which
`deno task start` -- outside Vite entirely -- never sets.
