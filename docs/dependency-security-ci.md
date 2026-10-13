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

The Validation workflow runs on pull requests and main, with read-only repository
permissions. It checks types, ESLint, Vitest (including golden fixtures), a
production build, the dependency audit, Chromium Playwright and Python pytest.
Node and Python dependency downloads are cached, and jobs have execution limits.
Pages deployment remains a separate workflow, restricted to main on a push or
explicit workflow dispatch. Deployment permissions are granted only to its
deployment job. No pull-request workflow can deploy the site.

Two existing browser tests attempted to persist edits to regenerated in-memory
demo rows. They now import synthetic data and test persistence across reloads.
The backup browser test now actually clears and restores the synthetic backup.
The obsolete navigation wait for a Settings-only control is removed. The Python
sample test generates its own synthetic HTML instead of depending on a missing,
ignored local sample file. Private-statement acceptance tests remain optional;
CI never requests or uploads real financial evidence.
