# Dependency security and reproducible validation

The npm registry's `xlsx@0.18.5` has no patched npm release. SheetJS's own
[installation documentation](https://docs.sheetjs.com/docs/getting-started/installation/)
identifies `cdn.sheetjs.com` as its primary distribution site. The project now
pins the original maintainer's `xlsx@0.20.3` tarball at
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; the lockfile pins its SHA-512
integrity. No unofficial fork is used. Version 0.20.3 is newer than the fixes for
[prototype pollution](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)
(0.19.3) and [ReDoS](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) (0.20.2).

The existing read/write API and both legacy adapters are retained unchanged.
Raw serial dates, Chinese sheet names, string card suffixes, integer minor-unit
conversion, currencies and formula-like text receive regression coverage. XLSX
export continues to write monetary decimals as strings, avoiding Excel numeric
rounding and preventing formula-like merchant text from being executable cells.
CSV behavior is unchanged.

The initial audit also found vulnerable Vitest/mocker/tinypool dependencies.
Vitest and its UI are pinned to patched 4.1.11, retaining support for the CI's
Node 22 runtime. The post-update `npm audit --json` reports zero vulnerabilities;
no advisories are suppressed. CDN availability is now needed for fresh installs,
and future releases require reviewing the maintainer's distribution and advisories.

The single Validation workflow (`.github/workflows/ci.yml`) runs on pull requests,
main pushes and explicit workflow dispatch. Its Web and Python jobs run in
parallel with read-only repository permissions. They retain types, ESLint, Vitest
(including golden fixtures), one production build, the dependency audit,
Chromium Playwright and Python pytest. Dependency caching and time limits remain.

The Deploy job requires both validation jobs to succeed, and only runs for a
push or dispatch on `main`. After every Web check succeeds, that same run uploads
its `web/dist` as `github-pages`; Deploy consumes the artifact from the current
workflow run, without reinstalling dependencies or rebuilding. PRs and dispatches
on other branches neither upload Pages artifacts nor deploy. Only Deploy receives
Pages and OIDC write permissions, and the existing `github-pages` environment and
Pages configuration action are retained.

PR updates cancel older checks. Main runs are queued without cancellation so
an active deployment can finish safely. The deployment slot also uses the
existing `pages` concurrency group without cancellation. Since GitHub does not
guarantee queue order, Deploy checks the current main SHA after acquiring that
slot and skips superseded revisions. Failure to read the current SHA prevents
deployment. A newer commit arriving after the check waits for the active main
run; its deployment cannot be overtaken by that older run.

There is no `workflow_run` handoff or cross-run artifact lookup. The former
`web-pages.yml` workflow and its duplicate install, checks and build are removed.
Main production deployment is not exercised by local checks or PR CI; it occurs
only after an authorized main push or an explicit main dispatch passes validation.

Two existing browser tests attempted to persist edits to regenerated in-memory
demo rows. They now import synthetic data and test persistence across reloads.
The backup browser test now actually clears and restores the synthetic backup.
The obsolete navigation wait for a Settings-only control is removed. The Python
sample test generates its own synthetic HTML instead of depending on a missing,
ignored local sample file. Private-statement acceptance tests remain optional;
CI never requests or uploads real financial evidence.
