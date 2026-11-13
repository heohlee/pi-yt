---
name: git-workflow
description: "Trigger: starting any change in pi-yt, creating or triaging an issue, labeling, planning work, creating a branch or worktree, or creating, preparing, reviewing or merging a pull request. Issues are optional and never a gate; each change gets its own worktree and branch; pull requests follow the template, the CI check and the merge-commit method."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use before the first write of any pi-yt change (feature, bug, chore, docs or skill edit), when an issue needs creating, labeling or triaging, when planning transitions to implementation, and when a change is pushed for a pull request, needs a PR created or edited, or is checked for review readiness.

Do not use for read-only work: Q&A, reading, searching, inspecting history or running tests all leave the main checkout usable. Loading this skill does not authorize GitHub writes, pushing, opening a PR or merging.

Generic PR, branch or issue instructions installed in your agent describe other repositories and do not apply here. pi-yt does not use `type:*` labels. Follow this skill rather than importing checks from another repository, and do not reconcile the two.

## Hard Rules

- An issue is optional for every change and every contributor: a pull request may arrive without one, and no CI check requires it. Recommend opening an issue first only for large or design-changing work, so the idea can be discussed before code is written. Never block, close or delay a change for lacking an issue, and never require an approval label or an approval round trip. Do not reintroduce issue or approval requirements through labels, title conventions or contributor roles.
- One change, one worktree, one branch. The main checkout is for reading, syncing and merging.
- Every required check must pass before merge, including on documentation-only PRs. Never interpret readiness as permission to merge.
- Never put cookies, browser profile data, account emails or full yt-dlp output in issues, PR bodies, comments, screenshots or logs. Summarize or redact.
- Respect the current task's authorization: if GitHub writes are prohibited, report the proposed issue, labels or PR without creating or editing anything remotely.

## Issues

An issue is optional; when one exists, it governs the change: it is the intent anchor and the target of the PR's `Closes #<n>` line. Search for an existing issue and reuse it if present. For large or design-changing work without one, propose one (title prefix, motivation, acceptance criteria) and create it before implementation when authorized. Then begin right away: no approval step is needed. Keep its classification truthful as scope changes, subject to authorization for remote edits.

### Issue Forms

`.github/ISSUE_TEMPLATE/` has a bug report form (applies `bug`) and a feature request form (applies `enhancement`). Blank issues are disabled in the web UI, so documentation, chores, CI and tooling issues are created with `gh issue create`.

### Label Taxonomy

| Group | Rule | Values |
| --- | --- | --- |
| Type | Exactly one for bugs, capabilities or docs-only work | `bug`: incorrect behavior; `enhancement`: new capability; `documentation`: documentation only |
| Maintenance | No label | Chores, CI and tooling issues remain unlabeled; do not invent a chore type |
| Triage | Only when applicable, not a type or approval gate | GitHub defaults: `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix` |

Use only these labels, on issues and PRs alike; never create labels, invent `type:*` labels or import another repository's taxonomy. Apply the best fit best-effort and note uncertainty; missing or imperfect labels never block or delay work. Classification belongs to the issue; PR labels are optional and need not duplicate it. An issue that is only a question or triage record needs no type label. Verify the live inventory with `gh label list --repo heohlee/pi-yt`; do not claim it contains only these labels without checking. Labels outside the permitted set do not authorize using them or changing the remote inventory.

The permitted set is `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`. There are no area or status labels in this taxonomy; do not add them. The feature request form's Area dropdown is issue content, not a label.

Labels are informational. Only claim release-note grouping by labels if an actual `.github/release.yml` configures it; `.github/workflows/release.yml` is a different file.

### Issue Title Prefixes

New issue titles start with one prefix matching the change type: `[Feature]`, `[Bug]`, `[Docs]` or `[Chore]`. Example: `[Feature] Add export to CSV`. The forms apply `[Bug]` and `[Feature]`; apply the others manually. The prefix is a human-readable aid, not a replacement for the label: a missing or wrong prefix is not a violation and never becomes a gate; when prefix and label disagree, the label wins. Do not bulk-edit existing titles.

## Branches and Worktrees

Branch `type/slug`, lowercase and without spaces, based on an updated `main`. The worktree goes in the sibling directory next to the repository root, never inside it: `../<repo>-worktrees/<type>-<slug>`, where `<repo>` is the main checkout's directory name (`pi-yt` for a default clone), so several changes can run in parallel.

| Prefix | Use for |
| --- | --- |
| `feat/` | User-facing capability |
| `fix/` | Incorrect behavior |
| `refactor/` | Restructuring without intended behavior change |
| `perf/` | Performance improvement without intended behavior change |
| `docs/` | Documentation only |
| `test/` | Test-only changes |
| `chore/` | Tooling, skills and repository configuration |
| `ci/` | CI and release workflow changes |

Do not invent other prefixes or impose an issue-number slug requirement; issue linkage belongs in the PR body. pi-yt runs no server and keeps no local database, so worktrees share no mutable local state; tests keep their state in fresh system temp directories.

1. Create the worktree from the updated base. `--track` sets the upstream, so a later push needs no `-u`:

   ```
   git fetch origin
   git worktree add --track -b <type>/<slug> ../<repo>-worktrees/<type>-<slug> origin/main
   cd ../<repo>-worktrees/<type>-<slug>
   ```

2. Work, test and commit only inside that worktree; the local checks mirror the required checks below. There is no build step: the tests run without installing anything (`npm test`); run `npm ci` once for the type check and lint (`npm run typecheck`, `npm run lint`).

3. After the PR is merged, remove the worktree from the main checkout with `git worktree remove ../<repo>-worktrees/<type>-<slug>`, only with authorization.

## Pull Requests

- The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: Why, Summary, Verification, Not verified, and the optional issue-closing line. Describe observed verification, not intended checks. Manual checks in Pi belong in Verification; anything not tried belongs in Not verified.
- When an issue exists, link it with a standalone `Closes #<n>` line. No check requires the line; a missing issue or link never blocks a PR.
- Pending or failing required checks block merge. Check definitions live under `.github/workflows/`; point at them rather than duplicating their flags, and do not claim a check that has no workflow. Making a check merge-blocking requires repository protection configuration (a ruleset or branch protection on `main`); the workflow file alone does not establish that setting.
- Preserve the merge-commit style used in this repository. With explicit merge authorization, use `gh pr merge --merge`, not squash or rebase, and no other method.

### Required checks

- `CI` (`.github/workflows/ci.yml`): the aggregate job that passes only when every `Checks (Node 24)` and `Checks (Node current)` job passes. Those jobs run the release check tests (`node --test .github/scripts/release-check.test.cjs`), tests with an 85% line, branch and function coverage minimum for `lib/` and `extensions/` (`npm run coverage`), type check (`npm run typecheck`), lint and format (`npm run lint`) and package contents (`npm pack --dry-run`).

The `Security` workflow (`.github/workflows/security.yml`: CodeQL and `npm audit --audit-level=high`) also runs on pull requests but is not a required check; treat a failure as something to fix or explain. No check validates issue linkage.

### What Proves A Pull Request Here

- `CONTRIBUTING.md`: contributor-facing workflow, local checks and privacy rules
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- The workflows that actually run on pull requests:
  - `.github/workflows/ci.yml`: `CI` (required)
  - `.github/workflows/security.yml`: `Security` (not required)
- `tests/`: test files and shared fakes; tests never touch real browsers, keyrings, the network or mpv

The release workflow (`.github/workflows/release.yml`) runs on pushed `vX.Y.Z` tags, not on PRs; it is not a missing PR gate. Publishing waits for approval in the `npm` environment. Do not report another repository's checks as missing here. Do not call a local command run proof that remote required checks passed.

### Commit Format

Use Conventional Commits, such as `feat: ...`, `fix: ...`, `docs: ...` or `ci(release): ...`. Scopes are optional. Keep commits focused. PRs retain branch commits through a merge commit; the PR title is not a squash-commit message and does not replace the individual commit history.

## Decision Gates

| Condition | Result |
| --- | --- |
| No issue exists for the change | GO: the issue is optional; suggest one only for large or design-changing work |
| Issue exists | GO: no approval wait |
| Bug, capability or docs issue has missing or conflicting type labels | GO: apply or propose the best-fit single type; never block over labels |
| Label is ambiguous or outside the permitted set | GO: note or propose a correction; do not create labels |
| Chore, CI or tooling issue is unlabeled | GO: this is the intended classification |
| No issue, or an issue the PR does not link | GO: suggest adding `Closes #<n>` when an issue exists |
| Branch name or prefix deviates | GO: report the deviation in `branch_valid` |
| A required check fails or is pending | BLOCKED for merge |
| Required checks pass | GO for readiness, not authorization to publish or merge |
| The release workflow does not run on the PR | Not a missing PR gate |

## Output Contract

Return:

- `issue`: number/URL or "none"; `labels_valid`: true/false, with the exact taxonomy deviation if false;
- `worktree`: path, branch and base commit; `branch_valid`: true/false, with the naming deviation if any;
- `pr`: number/URL or "none"; `issue_linked`: true/false, with the exact closing line if any (informational);
- `gate`: GO or BLOCKED, naming failing or pending required checks;
- verification performed, anything not verified, and proposed corrections or GitHub writes not performed because authorization was absent.

## References

Paths below are repository-relative.

- `CONTRIBUTING.md`: workflow, local checks, merge policy, releases and privacy rules
- `.github/ISSUE_TEMPLATE/`: bug report and feature request forms
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.github/workflows/`: actual check and release definitions
- GitHub label inventory: `gh label list --repo heohlee/pi-yt`
