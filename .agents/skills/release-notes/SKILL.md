---
name: release-notes
description: "Trigger: release notes, release message. Draft concise, evidence-backed pi-yt release copy without publishing."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use when drafting or revising release text. Do not use for bumping versions, managing tags or publishing to npm.

## Hard Rules

- Write English. Use only the version as the title; do not repeat it as a body heading.
- Describe verified user impact from the selected source. Never invent changes, verification results or roadmap promises.
- Omit empty sections, repeated README content and routine CI reports. Do not use en dashes, em dashes or middle dots.
- Never include cookies, browser profile data, account emails or yt-dlp output, even in screenshots.
- Never create tags, change releases/labels, push, publish to npm or alter publication workflows. Return a draft; publication needs separate explicit authorization.

## Decision Gates

| Content | Sections |
| --- | --- |
| First release | Short product introduction, Highlights with the main capabilities and Getting started |
| Fixes only | Fixes |
| Features and fixes | Features, then Fixes |
| Noteworthy change needing explanation or a screenshot | Optional Highlights; do not repeat Features |
| Installation changes | Getting started only when instructions changed |
| Required upgrade action or incompatibility (for example a new minimum Node, mpv or yt-dlp requirement) | Upgrade notes before the changes |

## Execution Steps

1. Resolve the requested version, exact target and previous published release. Ask if ambiguous. Inspect the source range and merged PRs; for a first release inspect capabilities instead.
2. Use native generated notes as input, not finished copy. Inspect every change, including unlabeled ones, instead of dropping it.
3. Select only applicable sections. Read `assets/examples.md` for hypothetical formatting, never factual claims.
4. Finish with a real Full changelog comparison when a previous release exists, then one Documentation link line. Pin links to verified source refs. Do not add a Documentation section. The README has a Spanish translation (`README.es.md`); release notes stay in English and link only the English README.

## Output Contract

Return the version-only title and Markdown body, plus a separate private evidence summary: target/range, change sources and unresolved facts or links. Keep that summary out of the public text. Never claim publication.

Once the owner approves the body, it is stored as `.github/release-notes/vX.Y.Z.md`, added through a PR before the tag is pushed. The release workflow requires that file for the pushed `vX.Y.Z` tag; a missing, empty or whitespace-only file fails the release. The GitHub Release uses the file only, with no generated-notes fallback. The tag must match `version` in `package.json`.

## References

- [Formatting examples](assets/examples.md)
- `CONTRIBUTING.md`: release process
