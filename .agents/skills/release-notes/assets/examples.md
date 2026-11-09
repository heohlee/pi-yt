# Release-note examples

These changes and versions are hypothetical, not implemented features or a roadmap.
Use source evidence, never these bullets, when drafting a real release.
Title lines are release metadata, not headings to repeat in the body.
The examples use readable main-branch documentation links; pin real release links to verified source refs and replace the illustrative comparison range with a real link.

## Fixes-only release

Title: `v0.1.1`

Body:

```markdown
## Fixes

- Keep the selected video after the overlay list refreshes.
- Show a clear message when mpv is not installed.

**Full changelog:** `v0.1.0...v0.1.1`

[Documentation](https://github.com/heohlee/pi-yt#readme)
```

## Features and fixes

Title: `v0.2.0`

Body:

```markdown
## Features

- **Search:** filter the library from the `/yt` overlay.
- **Resume playback:** continue a video where mpv left it.

## Fixes

- Keep the selected video after the overlay list refreshes.

**Full changelog:** `v0.1.0...v0.2.0`

[Documentation](https://github.com/heohlee/pi-yt#readme)
```

For a first release, introduce verified product capabilities and include Getting started.
Do not invent a previous release or a comparison range.
For later releases, omit Getting started unless installation instructions change.
Put required upgrade actions in Upgrade notes before Features/Fixes.
Do not add Highlights merely to repeat Features, or an empty category.
