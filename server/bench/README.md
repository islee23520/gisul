# Search regression benchmark

Run from the repository root after `npm --prefix server run build`:

```sh
node server/bench/search.mjs --check
```

The default `catalog.json` contains 12 entirely synthetic skill metadata entries, including two explicit-only entries. It contains no private catalog metadata or skill bodies and is used only by this benchmark, never for runtime routing or installation. Connected catalogs are unchanged; their results depend on their own names, descriptions and keywords.

The 32 maintainer-authored cases contain 24 expected matches in Korean and English and 8 no-match queries. They measure Hit@1, Hit@5, MRR, negative abstention, exact-name lookup, invocation filtering, and warm/cold local search latency. Cases and metadata were developed together: this is a regression suite, not an independent holdout or proof of live catalog quality. Local timings exclude network and agent overhead.

CI requires Hit@1 ≥ 90%, Hit@5 ≥ 98%, all negative and exact-name cases passing, preserved invocation policy, and warm p95 below 20 ms. Cold index construction is reported separately and can cost more than legacy matching.

Use `--inventory path.json` or `--skills-root /path/to/skills` to evaluate other metadata against the same cases; expected skill names must exist for the scores to be meaningful. `--output report.json` saves detailed results. `--mode legacy` and `--implementation /path/to/skill-search.ts` support comparisons. `--save-inventory path.json` saves a metadata-only snapshot.

This change updates the common bridge, search implementation, loader guidance and CI regression checks. It does not publish skill content, install a personal plugin, or deploy a server.
