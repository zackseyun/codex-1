# codex-js-renderer

Experimental JavaScript terminal renderer for `codex-fork`.

It keeps the Codex backend in Rust and talks to `codex app-server` over the
documented JSON-RPC stdio transport.

## Why this exists

- lets the backend stay close to upstream
- moves presentation and grouping into a separate JS layer
- makes it easier to iterate on phase banners, workstream grouping, and inline
  detail toggles

## Launch

Use the repo wrapper:

```sh
scripts/codex-fork-ui
```

Or pass an initial prompt:

```sh
scripts/codex-fork-ui "summarize this repository"
```
