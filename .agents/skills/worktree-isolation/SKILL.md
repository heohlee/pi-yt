---
name: worktree-isolation
description: "Trigger: starting any change in the pi-yt repository. Create a new git worktree under ../<repo>-worktrees (where <repo> is the main checkout's directory name) instead of working in the main checkout, so several changes can run in parallel."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Run before the first write of any change: feature, bug, chore, docs, or skill edit. Not needed for read-only work: reading, searching, inspecting history or running tests all leave the main checkout usable.

## Hard Rules

- One change, one worktree, one branch. The main checkout is for reading, syncing, and merging.
- The worktree goes in the sibling directory next to the repository root, never inside it: `../<repo>-worktrees/<type>-<slug>`.
- Branch `<type>/<slug>`, based on an updated `main`. The prefixes are listed in `../pr-governance/SKILL.md`.
- An issue is optional; when one exists, it governs the change (`../issue-governance/SKILL.md`).

## Execution Steps

1. Create the worktree from the updated base. `--track` sets the upstream, so a later push needs no `-u`:

   ```
   git fetch origin
   git worktree add --track -b <type>/<slug> ../<repo>-worktrees/<type>-<slug> origin/main
   cd ../<repo>-worktrees/<type>-<slug>
   ```

2. Work, test and commit only inside that worktree. There is no build step: the tests run without installing anything (`npm test`); run `npm ci` once for the type check and lint (`npm run typecheck`, `npm run lint`).

3. After the PR is merged, remove the worktree from the main checkout with `git worktree remove ../<repo>-worktrees/<type>-<slug>`, only with authorization.

## Output Contract

Report the worktree path, its branch and the base commit.

## References

- `../../../AGENTS.md`: skill registration.
- `../issue-governance/SKILL.md`: when an issue is recommended and label taxonomy.
- `../pr-governance/SKILL.md`: branch prefixes.
