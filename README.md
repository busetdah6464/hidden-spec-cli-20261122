# mend — one patch tool for every AI edit format

make.fun entry for [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
build mend, a command-line tool that applies AI-written edits in four formats to a tree of text files,
to the specification that ships in the kit (`SPEC.md`).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`,
  the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success it prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move) and
`ok: <n> files`. On failure it prints `error: ...` lines and `failed: <k> of <n> edits`, and writes
nothing. Exit codes: 0 applied, 1 some edits failed, 2 usage / unreadable patch / parse error.

## The four formats

- **Unified diffs** — sections with `diff --git`, `---`/`+++`, rename, new/deleted file mode and hunks.
  A hunk's old lines are found at the first of three tiers (exact; trailing whitespace ignored;
  leading and trailing whitespace ignored, with re-indentation), taking the occurrence nearest the
  hunk's line number. Files without a final line break stay that way unless the patch says otherwise.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines,
  `>>>>>>> REPLACE`. The old lines must occur exactly once at their tier.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`, `*** Delete File:`
  and `*** Update File:` sections, optional `*** Move to:`, `@@` anchors and `*** End of File`.
- **JSON edits** — one JSON array of edit objects, or JSON Lines: `create`, `str_replace`, `insert`.

Every edit is checked for safe paths before anything else, and a failed edit changes nothing while
the edits after it still run. All changes are written only when no edit failed.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's runner, kept as it is: in a trial it reads the checks from the env and runs
  `main.ts` on each one.
- `SPEC.md` — the specification this tool implements.

## Practice results

- Kit practice set (`program/generator/practice.json`): **100 of 100 passed, practice score 1000**.
- Kit practice instances trial-0, trial-1, trial-2 (300 further checks): see commit history.

## License

MIT.
