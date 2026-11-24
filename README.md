# mend

One command-line tool that applies AI-written edits in four formats to a tree of files: unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

Built for the make.fun competition `hidden-spec-cli-01-run-20261122`. The whole behaviour is `SPEC.md` in the kit; the entry is `main.ts` (Node 22, standard library only), run as:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`runner.ts` is the kit's trial runner, kept as it is. Practice set: 100 of 100, score 1000, plus 26 extra edge cases covering moves, CRLF files, files without a final line break, `--check`, `--strict`, unsafe paths, and the V4A cursor and end-of-file rules.

## License

MIT. See `LICENSE`.
