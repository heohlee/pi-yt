# pi-yt — Agent Skills Index

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute, local checks, merge policy and privacy rules.

When working on this project, load the relevant skill(s) BEFORE writing any code.

## How to Use

1. Check the trigger column to find skills that match your current task.
2. Load the skill by reading the `SKILL.md` file at the listed path.
3. Follow ALL patterns and rules from the loaded skill.
4. Multiple skills can apply simultaneously.

## Precedence

Repository-local skills under `.agents/skills/` take precedence over generic or global skills with the same purpose (for example generic branch, PR or issue skills). When a skill is added, renamed or removed, update this index in the same change.

## Skills

| Skill | Trigger | Path |
| --- | --- | --- |
| `git-workflow` | Starting any change in this repository (before the first write), creating or triaging an issue, labeling, planning work, creating a branch or worktree, or creating, preparing, reviewing or merging a pull request. | `.agents/skills/git-workflow/SKILL.md` |
| `node-tests` | Node tests, `tests/*.test.ts`, fakes for mpv/yt-dlp/fetch, type stripping limits, or CI test evidence. | `.agents/skills/node-tests/SKILL.md` |
| `release-notes` | Release notes or release messages. | `.agents/skills/release-notes/SKILL.md` |

## Privacy

Never commit, paste or log cookies, browser profile data, account emails or full yt-dlp output, in code, tests, issues, PRs or release notes. Tests never touch real browsers, keyrings, the network or mpv.
