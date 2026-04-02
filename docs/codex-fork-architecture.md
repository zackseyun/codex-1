# `codex-fork` architecture

This document explains the current structure of Zack's `codex-fork` setup after the JS-renderer experiments.

## Executive summary

- There are now **two frontends** for the same forked Codex backend:
  - the original **Rust TUI**
  - a newer experimental **JavaScript terminal renderer**
- The **backend remains Rust Codex** and is intentionally kept close to upstream so Zack can continue merging from the parent project.
- The JS renderer does **not** replace the backend. It talks to the backend through `codex app-server` over the documented JSON-RPC stdio protocol.

## Current layers

### 1. Core backend

- **Binary:** `codex-rs/target/debug/codex`
- **Primary codebase roots:**
  - `codex-rs/cli`
  - `codex-rs/core`
  - `codex-rs/app-server`
  - `codex-rs/app-server-protocol`
- Responsibilities:
  - model orchestration
  - tools / shell / patch execution
  - rollout/thread persistence
  - event generation
  - app-server transport

### 2. Existing Rust terminal UI

- **Code root:** `codex-rs/tui`
- This is the original interactive frontend that ships with the Rust CLI.
- This path is still used when Zack runs plain:

```sh
codex-fork
```

### 3. Experimental JavaScript terminal renderer

- **Package:** `codex-js-renderer`
- **Entry point:** `codex-js-renderer/src/index.tsx`
- **Tech stack:**
  - React
  - Ink
  - TypeScript
  - `tsx`
- This is a separate presentation layer, not a backend rewrite.
- It was added to validate the idea that the frontend should evolve independently from the upstream-mergeable Rust backend.

## Communication boundary

The JS renderer talks to the backend through:

- `codex app-server`
- transport: **stdio JSON-RPC**

Relevant backend pieces:

- `codex-rs/app-server/README.md`
- `codex-rs/app-server`
- `codex-rs/app-server-protocol`
- generated TypeScript schema in `codex-rs/app-server-protocol/schema/typescript`

The intended architectural benefit is:

- backend logic remains upstream-friendly
- renderer can iterate faster
- frontend can be replaced again later without changing backend execution semantics

## Launch paths

### Plain forked CLI / Rust TUI

Local machine wrapper:

- `/Users/zackseyun/.npm-global/bin/codex-fork`

Behavior:

- if first arg is `ui`, it launches the JS renderer
- otherwise it launches the Rust Codex binary directly

### JS renderer launchers

Repo script:

- `scripts/codex-fork-ui`

Local convenience wrapper:

- `/Users/zackseyun/.npm-global/bin/codex-fork-ui`

Current usage:

```sh
codex-fork ui
codex-fork-ui
codex-fork-ui --last
codex-fork-ui --resume <threadId>
```

## What the JS renderer currently does

The current JS renderer:

- starts `codex app-server`
- initializes a JSON-RPC session
- starts or resumes a thread
- starts or steers turns
- listens to:
  - `thread/*`
  - `turn/*`
  - `item/*`
  - `item/agentMessage/delta`
- maps backend events into a frontend-side summary model
- renders a compact dashboard instead of a transcript-first feed

Important note:

- the JS renderer is **not yet feature parity** with the existing Rust TUI
- it is a product/design experiment, not a complete replacement

## Why this structure exists

The main idea behind this architecture was:

1. keep the Codex backend mergeable from upstream
2. stop forcing all UX/design experimentation into the Rust TUI
3. create a separate frontend that can be redesigned faster
4. use the app-server boundary as the stable seam

## What has changed locally

There are really three classes of work in this fork:

### A. Rust TUI presentation tweaks

Examples:

- less raw command noise
- more semantic shell summaries
- `Ctrl+T` details path

### B. JS renderer experiment

Examples:

- `codex-js-renderer`
- `scripts/codex-fork-ui`
- `codex-fork ui`

### C. Local machine launch wiring

Examples:

- `/Users/zackseyun/.npm-global/bin/codex-fork`
- `/Users/zackseyun/.npm-global/bin/codex-fork-ui`

## Practical takeaway

If Claude Code is asked to improve the experience, it should think of the system like this:

- **backend:** Rust Codex and app-server
- **stable protocol seam:** app-server JSON-RPC
- **legacy frontend:** Rust TUI
- **experimental frontend:** JS terminal renderer

The right place to change the visual UX aggressively is the **JS renderer**, not the backend and not necessarily the Rust TUI.
