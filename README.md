# update-ktc

Update the POSIX and Windows **JetBrains Kotlin Toolchain** wrappers together,
verify upstream checksums, run `build` and `check`, and open a focused upgrade PR.
Works on Linux, macOS, and Windows with Node.js 22+ and Bash.

```yaml
name: Update Kotlin Toolchain
on:
  schedule:
    - cron: '0 8 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  update:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: Heapy/setup-ktc@v1
      - uses: Heapy/update-ktc@v1
```

Use full release commit SHAs for immutable references. The repository must allow
GitHub Actions to create pull requests. A PR created using `GITHUB_TOKEN` normally
does not trigger other workflows; this action performs validation before creating
it. Use a GitHub App token or suitably scoped PAT via `token` if PR CI must trigger.

| Input | Default | Purpose |
|---|---|---|
| `version` | `latest` | Latest stable upstream release or exact version >= 0.12.0 |
| `working-directory` | `.` | Project folder in the checked-out repository |
| `validate` | `true` | Run build and all registered checks after an update |
| `create-pull-request` | `true` | Set false for local-only changes |
| `token` | `github.token` | GitHub API / PR token |
| `branch` | `automation/kotlin-toolchain` | Dedicated upgrade branch |
| `base` | empty | PR base; empty uses the checked-out branch |

Outputs: `version`, `changed`, `pull-request-url`.

Commit existing wrapper edits before running. Both downloaded wrappers must pass
SHA-256 verification and agree on their embedded distribution pin before either
file is replaced. Checksums are fetched from the same official JetBrains Maven
repository; they detect corruption rather than independently authenticating the
upstream server. `latest` never downgrades a newer project version. An explicit
version can intentionally downgrade. Identical normalized wrapper contents are a
no-op. Validation runs the new local wrapper, even if a different global CLI exists.

Only wrapper paths are staged by the PR action. Use a clean checkout of the base
branch, and reserve the automation branch for this action. Existing upgrade PRs
are maintained by the pinned `peter-evans/create-pull-request` action. PR creation
is limited to push, schedule, and workflow_dispatch events; do not run this workflow
against untrusted code with a write-capable token. The action never merges a PR.

Setup and caching are optional but recommended. Project credentials needed for
private dependencies can be supplied using normal workflow environment settings.
The `token` input is not passed to the project's build/check subprocesses.

Development: `npm test` and `npm run check`. CI exercises a real 0.12.2 → 0.13.0
upgrade and a second no-op invocation on all three operating systems.

## Related actions

- [setup-ktc](https://github.com/Heapy/setup-ktc)
- [ktc-check](https://github.com/Heapy/ktc-check)
- [ktc-publish](https://github.com/Heapy/ktc-publish)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party
components retain their original licenses.
