# `codex-fork` JS renderer handoff for Claude Code

This document is meant as a direct handoff to Claude Code.

It explains:

- what the user originally wanted
- what was implemented
- why the result missed the mark
- what to do differently next time

## What the user actually wanted

The user did **not** merely want prettier terminal output.

The real request was closer to:

- show **less raw command noise**
- surface the **most important current point** quickly
- communicate **what is happening now**
- communicate **what branch of work** the agent is under
- make shifts in **phase / mode / workstream** visually obvious
- preserve access to detail, but keep detail in the background
- make the interface feel like a **high-signal operator view**, not a transcript dump

The user repeatedly emphasized:

- better hierarchy
- more semantic grouping
- stronger summaries / takeaways / alpha
- clearer visual communication
- a presentation layer that could evolve faster than the backend

The user also explicitly signaled that:

- terminal constraints felt too limiting
- a separate **JavaScript renderer** was desirable
- the Codex backend should remain mergeable from upstream

## What was built

### Phase 1: Rust TUI adjustments

Changes were made to the Rust TUI to:

- hide more raw commands by default
- move raw command detail behind a details/transcript path
- summarize shell activity more semantically
- add shell previews and repetition collapsing

This helped somewhat, but it did not solve the deeper UX problem.

### Phase 2: Separate JS renderer

A new experimental frontend was added:

- `codex-js-renderer`
- `scripts/codex-fork-ui`
- `codex-fork ui`

This renderer:

- uses Ink/React
- talks to `codex app-server` over stdio JSON-RPC
- leaves the Rust backend intact
- introduces a separate presentation layer

### Phase 3: JS renderer visual redesign

The first JS renderer version used:

- phase banners
- colored sections
- grouped activity rows

That version was too transcript-like and too visually noisy.

It was then redesigned into a compact dashboard with:

- `Overview`
- `Signal`
- `Recent activity`

### Phase 4: CLI usability fixes

The JS renderer later gained:

- `-h` / `--help`
- `--last`
- `--resume <threadId>`

## Why the user is saying this missed the mark

The criticism is valid.

The misstep was **not technical feasibility**.

The misstep was **product interpretation**.

### Core problem

The implementation kept thinking in terms of:

- transcript presentation
- event grouping
- semantic relabeling

But the user was actually asking for:

- **situational awareness**
- **operator cognition**
- **state visibility**
- **visual prioritization of the valuable alpha**

Those are not the same thing.

## Specific ways the implementation went wrong

### 1. Too much abstraction too early

The renderer abstracted events into categories and summaries before establishing:

- what the user considers the real unit of work
- what the user wants to monitor
- what constitutes “important”

Result:

- summaries felt detached from the actual work
- the user could not trust what was being surfaced

### 2. It optimized presentation before defining the right information model

The implementation focused on:

- colors
- banners
- grouping
- compactness

before clearly defining the state model for:

- current objective
- current subgoal
- active process
- repo/cwd/branch
- what just changed
- what matters now
- what is blocked

### 3. The UI still behaved like a transcript viewer

Even after redesign, the renderer still came from a “stream of events” mindset.

The user wants something closer to:

- an operator dashboard
- a mission control panel
- a running state machine with meaningful summaries

### 4. “Signal” was too vague

The `Signal` panel was added to surface takeaways, but:

- it was not grounded in a clearly defined signal model
- it sometimes surfaced trivial text
- it did not yet prove trustworthiness

The user immediately noticed this.

### 5. Colors were decorative rather than semantic

The colors were chosen to separate categories, but not enough thought was put into:

- what each color should mean
- when a color should demand attention
- when the interface should go quiet

Result:

- the interface looked “styled”
- but not necessarily more legible or more useful

### 6. Not enough “vision of what is going on”

This is probably the most important user criticism.

The user still lacks:

- a strong sense of current trajectory
- a strong sense of progress
- a strong sense of live branch/workstream ownership
- a strong sense of what to pay attention to right now

That means the UI failed its main job.

## What Claude Code should understand

The user is **not** asking for a better transcript.

The user is asking for a better **operational representation of ongoing work**.

If Claude Code keeps thinking:

- “How do I summarize these events?”

it will likely miss again.

Claude Code should instead think:

- “What are the stable, high-value states a human operator actually needs to see?”

## Suggested mental model for the next attempt

Build around these first-class concepts:

### 1. Mission

- What is the user trying to achieve?
- This should remain visible almost all the time.

### 2. Current focus

- What is the agent actively trying to do right now?
- This should be one line, stable, and high confidence.

### 3. Workstream / branch of work

- Example: discovery, editing, debugging, validation, deployment, summarization
- Should be visible, but quieter than the mission/current focus

### 4. Live activity

- What concrete operation is happening now?
- Example: searching repo, reading file, running test, editing files
- This must stay grounded in the actual underlying work

### 5. Latest takeaway

- What did the system just learn that matters?
- This should be sparse and trustworthy

### 6. Progress / blockage

- Are we moving?
- Are we stuck?
- What is the bottleneck?

## Recommended UI direction

Do **not** begin from a transcript.

Begin from a dashboard with at least these zones:

### A. Persistent top summary

- mission
- current focus
- workstream
- cwd / branch
- active mode / status

### B. Live operations pane

- very compact current operations
- grouped by type
- repeated operations collapsed
- raw details optional

### C. Latest findings / takeaways

- only the most recent high-value conclusions
- no filler
- no stream-of-consciousness

### D. Optional history drawer

- transcript-like material should live here
- not in the main operator surface

## Concrete product advice

### Keep

- separate JS renderer over app-server
- backend/frontend separation
- easy upstream merges
- optional raw details toggle

### Avoid

- repeated large banners
- overly decorative color segmentation
- transcript-first layouts
- generic “signal” blocks without a precise definition of signal
- over-summarization that hides the actual work

### Add next

- a strong sticky top status region
- live current-operation tracking
- better progress/provenance/status indicators
- explicit “what changed in the last 10 seconds” logic
- real animation only if it clarifies state, not for ornament

## Advice on working with this user

The user appears to care deeply about:

- information hierarchy
- operator cognition
- visual meaning
- fast pattern recognition
- knowing what matters now

So Claude Code should:

- validate the information model before polishing the visuals
- show a proposed mental model explicitly
- confirm what deserves top-level visibility
- prototype quickly, but avoid overcommitting to decorative structure too soon

In other words:

- ask “what deserves to be permanent?”
- ask “what deserves to interrupt?”
- ask “what deserves to be hidden?”

Those questions are more important here than:

- what colors to use
- what icons to use
- what the feed should look like

## Best next move for Claude Code

If Claude Code takes over from here, the best path is:

1. keep the JS renderer architecture
2. stop thinking transcript-first
3. define the operator information model explicitly
4. redesign the screen around persistent mission/focus/progress/takeaway primitives
5. only then rework the visual system

## Bottom line

The technical direction was probably right:

- separate JS renderer
- backend preserved
- app-server boundary

The product interpretation was not yet right.

The user wanted:

- a way to **see what matters**

but the implementation still mostly delivered:

- a different way to **look at events**

That gap is the real issue Claude Code should solve next.
