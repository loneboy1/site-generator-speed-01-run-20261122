# site-generator-speed-01-run-20261122

A faster drop-in for make.fun's own `makefun-site` 1.0.0 static site
generator: `solve.js` returns, for every case's input, exactly the output
tree `makefun-site` 1.0.0's `build` returns — every page's `index.html`,
the index and tag pages, `build-report.txt` and each static file, byte
for byte — only faster.

## Layout

- `solve.js` — the whole generator, dependency-free ES module. `run(input)`
  is the entry point.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.

## How it is faster

The reference builds token objects for every Markdown block, renders
inline content with a regex escape per character, re-slugifies the same
tag names over and over, and concatenates template output string by
string. This version:

- renders Markdown in a single pass straight into an output array
  (no token objects, plain runs escaped in bulk);
- renders templates into a shared output array, so includes cost no
  intermediate strings;
- memoises slugs, long dates and link targets within one case;
- scans front matter line by line without splitting the file, and
  counts words with a hand-rolled whitespace scan.

## Check

Run the entry on the kit's practice set and score it with the kit's
scorer (from the kit directory):

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/scores node <kit>/program/scorer/main.ts
```

## License

MIT — see `LICENSE`.
