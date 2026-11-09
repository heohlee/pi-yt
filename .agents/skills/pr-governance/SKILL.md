---
name: pr-governance
description: "Trigger: creating, preparing, or reviewing a pull request in this repository. Apply pi-yt's issue linkage, branch naming, PR template, CI gates and merge-commit policy."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use when a pi-yt change is about to be pushed for a pull request, needs a PR created or edited, or is being checked for review readiness.

Do not use for read-only Q&A or local work that will not become a PR. Loading this skill does not authorize pushing, opening a PR or merging.

## Precedence

Generic PR, branch or issue skills installed in your agent do not apply here. pi-yt does not use `type:*` labels. Follow this project skill rather than importing checks from another repository.

## Hard Rules

- Every PR links its governing issue with `Closes #<n>`. The issue is required by `issue-governance`; creating it authorizes the work, without an approval label or approval step.
- The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: Why, Summary, Verification, Not verified, and the issue-closing line. Describe observed verification, not intended checks. Manual checks in Pi belong in Verification; anything not tried belongs in Not verified.
- PR bodies, screenshots and logs never contain cookies, browser profile data, account emails or full yt-dlp output.
- PR labels are optional. Use only the existing GitHub defaults permitted by `issue-governance`; never invent `type:*` labels.
- Every required check must pass before merge. CI runs the `pr-issue` check, tests with an 85% coverage minimum (`npm run coverage`), type check (`npm run typecheck`), lint and format (`npm run lint`) and package contents (`npm pack --dry-run`). Check definitions live under `.github/workflows/`; point at them rather than duplicating their flags, and do not claim a check that has no workflow yet. `pr-issue` validates a standalone `Closes #<n>` against an existing same-repository issue (not a PR); comments and placeholders do not count. Making a check merge-blocking requires repository protection configuration; the workflow file alone does not establish that setting. Pending or failing required checks block merge, including on documentation-only PRs.
- Preserve the merge-commit style used in this repository. With explicit merge authorization, use `gh pr merge --merge`, not squash or rebase. Never interpret readiness as permission to merge.

## Branch Naming

Format: `type/slug`, lowercase and without spaces. The worktree directory is `../<repo>-worktrees/<type>-<slug>` (see `worktree-isolation`).

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

Do not impose an issue-number slug requirement; issue linkage belongs in the PR body.

## What Proves A Pull Request Here

- `CONTRIBUTING.md`: contributor-facing workflow, local checks and privacy rules
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.github/workflows/`: the actual check and release definitions
- `.agents/skills/node-tests/SKILL.md`: test layers and local evidence
- `.agents/skills/issue-governance/SKILL.md`: issue requirement and permitted labels

The release workflow (`.github/workflows/release.yml`) runs on pushed `vX.Y.Z` tags, not on PRs; it is not a missing PR gate. Do not report another repository's checks as missing here. Do not call a local command run proof that remote required checks passed.

## Commit Format

Use Conventional Commits, such as `feat: ...`, `fix: ...`, `docs: ...` or `ci(release): ...`. Scopes are optional. PRs retain branch commits through a merge commit; the PR title is not a squash-commit message and does not replace the individual commit history.

## Decision Gates

| Condition | Result |
| --- | --- |
| Governing issue is absent or not linked with `Closes #<n>` | BLOCKED for PR readiness |
| A required check fails or is pending | BLOCKED for merge |
| Issue is linked and required checks pass | GO for readiness, not authorization to publish or merge |
| The release workflow does not run on the PR | Not a missing PR gate |

## Output Contract

Return:

- `pr`: number/URL or "none";
- `issue_linked`: true/false, with the exact closing line;
- `branch_valid`: true/false, with the naming deviation if any;
- `gate`: GO or BLOCKED, naming missing issue linkage or required checks;
- verification performed and anything not verified.

## References

Paths below are repository-relative.

- `AGENTS.md`: skill precedence
- `CONTRIBUTING.md`: workflow, checks and merge policy
- `.agents/skills/issue-governance/SKILL.md`: issue requirement and labels
- `.agents/skills/worktree-isolation/SKILL.md`: worktree and branch creation
- `.github/PULL_REQUEST_TEMPLATE.md`: body contract
- `.github/workflows/`: actual check and release definitions
