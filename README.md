# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayoemanise/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayoemanise/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies an edit an AI model wrote to a tree of text files, in every format
models write edits in: a unified diff (even with drifted line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. It finds the lines an edit names at the first of three matching
tiers (exact, trailing whitespace ignored, any whitespace ignored — with re-indentation at the loosest), and
changes every file or none: each run's exit code, standard output and every file afterwards are exactly what
[SPEC.md](SPEC.md) says.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

Apply `fix.patch` from the repository root (omit the path, or pass `-`, to read the patch from standard input):

```sh
node main.ts fix.patch
```

`--check` does everything but write; `--strict` matches lines exactly (tier 0 only). The patch format is
auto-detected when `--format` is not given. Exit 0 prints one `A`/`D`/`M`/`R` line per changed path and
`ok: <n> files`; exit 1 prints one `error: <code> <path>` line per failed edit and changes nothing; exit 2
prints a single `error:` line for a usage, unreadable-patch, undetectable-format or parse failure.

## Development

- [SPEC.md](SPEC.md) is the whole contract: every sentence is a requirement, checked byte for byte.
- `check.ts` runs the 100 public practice checks against `main.ts`:

```sh
node check.ts <practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=v4tk2e29&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
