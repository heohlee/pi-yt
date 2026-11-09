# Contributing to pi-yt

Every change starts with a GitHub issue, including bugs, features, documentation, chores, CI and tooling. Open or find the issue **before implementation**. Creating the issue authorizes work: there is no separate approval step, approval label or required assignee.

## Quick path

1. Find or create an [issue](https://github.com/heohlee/pi-yt/issues/new/choose) describing the motivation and acceptance criteria. Use the bug report or feature request form; for documentation, chores, CI and tooling, use `gh issue create`.
2. Create a worktree and a branch from `main` named `type/slug` (see below).
3. Implement the scoped change with tests and relevant documentation.
4. Run the checks below and open a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
5. Include a standalone closing line in the PR body, replacing the example number with your issue:

   ```text
   Closes #123
   ```

## Branches and worktrees

Branches are named `type/slug`, lowercase, for example `fix/cookie-browser-detection` or `docs/install-steps`. Supported prefixes are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci` and `perf`.

Each change lives in its own git worktree in a sibling directory named after the main checkout (`<repo>-worktrees`, where `<repo>` is the main checkout's directory name), so several changes can run in parallel:

```sh
git fetch origin
git worktree add --track -b fix/cookie-browser-detection ../<repo>-worktrees/fix-cookie-browser-detection origin/main
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/), such as `fix: handle missing mpv socket` or `ci(release): require release notes`. Keep commits focused; they are preserved by the merge commit.

## Local checks

pi-yt is TypeScript run natively by Node.js 24 or newer (type stripping, no build step) and has no runtime dependencies. The tests need nothing installed; the type check and lint use the dev dependencies, so run `npm ci` once. CI runs:

```sh
npm test               # all tests/*.test.ts, with fakes for mpv, yt-dlp and fetch
npm run coverage       # the same tests; fails below 85% line, branch or function coverage of lib/ and extensions/
npm run typecheck      # tsc -p . (strict, no emit)
npm run lint           # biome ci: lint and format
npm pack --dry-run     # package contents
```

`npm run format` applies Biome's formatting.

Run a single test file with `node --test tests/<name>.test.ts`.

### Security checks

The `Security` workflow runs CodeQL (JavaScript/TypeScript) and `npm audit --audit-level=high` on pull requests, on pushes to `main` and weekly. It is not part of the required `CI` check, but treat a failure as something to fix or explain. Dependabot opens grouped update PRs for GitHub Actions and npm every week.

## Pull requests and merging

- Follow the PR template: Why, Summary, Verification, Not verified, and `Closes #<number>`.
- Report checks actually run and explicitly list anything not verified, including manual checks in Pi or Gentle Shell.
- Keep the change focused on its governing issue; update the issue if scope changes.
- The `pr-issue` check requires a standalone `Closes #<number>` line referencing a real issue in this repository. References inside HTML comments, fenced code blocks and the template placeholder do not count. Dependabot update PRs are exempt.
- Wait for all required checks to be green, including on documentation-only PRs. Local results are not proof that remote checks passed.
- Maintainers merge with a **merge commit**, not squash or rebase.

## Releases

1. Bump `version` in `package.json` to `X.Y.Z` through a PR.
2. Add the approved release notes as `.github/release-notes/vX.Y.Z.md` in a PR. The release fails without that file.
3. After merging, tag `main` with `vX.Y.Z` and push the tag.
4. The [release workflow](.github/workflows/release.yml) checks that the tag matches `package.json` and that the notes file has text, then runs the tests, type check, lint and package contents.
5. Publishing waits for the owner's approval in the `npm` environment. GitHub notifies the reviewer; approve it from the workflow run with **Review deployments**.
6. The workflow publishes `pi-yt` to npm with trusted publishing and provenance, then creates the GitHub Release from the notes file.

Trusted publishing needs a trusted publisher configured for the `pi-yt` package on npmjs.com: GitHub Actions, repository `heohlee/pi-yt`, workflow `release.yml` and environment `npm`. No npm token is stored in the repository.

npm only lets you add a trusted publisher to a package that already exists, so the first version is published once by hand (`npm publish` with two-factor authentication, without provenance). Add the trusted publisher right after it; a new configuration expires if no publish uses it within two days, so release the next tag soon after. Then restrict token-based publishing in the package settings.

## Privacy

pi-yt reads the user's YouTube library through their browser session. Never commit, paste or log cookies, browser profile data, account emails or full yt-dlp output, whether in code, fixtures, issues, PRs or release notes. Tests must never touch real browsers, keyrings, the network or mpv; use the fakes in `tests/`.
