# Before / after comparison

The first review patch improved safety and feedback but regressed throughput. Paired tests measured a median export of 15.90 s for that patch versus 11.71 s before it. This follow-up fixes the regression, preserves the stronger checks, and compares the final result against the original pre-review version.

Before: `e9aca7d8c06edf278b341a40ee3c3972ecbc18ff`. Final code: `298fd608b5cafff5dc70f3071ac2c73d75631fd7`. The intervening review patch was `0722e25`.

## Controlled result

Three alternating-order runs per version in fresh Chromium 156 contexts on the same Linux cloud runner. Same modded v9.0.5 save, same initial trait and same selected replacement. Input was 10,133,100 bytes; the campaign expands to 82,514,992 bytes. These are small-sample measurements, not a hardware-independent performance guarantee.

| Measure | Before review | Final version | Interpretation |
| --- | ---: | ---: | --- |
| Median export + verification + download request | 11.036 s | 7.988 s | **27.6% faster**; all three paired final runs were faster |
| Export range | 10.558–11.131 s | 7.725–9.382 s | Variation remains on the shared runner |
| Median save load | 3.548 s | 3.449 s | Approximately unchanged; 2.8% difference is too small to claim a robust loading improvement |
| Progress beside download button | Absent | Present; ~0.4 ms median DOM update | DOM timing is not pixel-render latency; the app explicitly allows a paint before processing |
| Export tasks longer than 500 ms | 2 per run | 1 per run | Fewer long pauses, not a freeze-free UI |
| Median longest export task | 763 ms | 802 ms | **Not improved**; the remaining synchronous scan is still noticeable |
| Page exceptions | 0 / 3 runs | 0 / 3 runs | No observed happy-path stability regression |
| Exported file | 10,625,729 bytes | 10,625,729 bytes | All six files were byte-for-byte identical |

A seventh run forced `scheduler.yield` to be unavailable. The MessageChannel fallback completed in 9.028 s, with the same output bytes and no page exception. This validates the fallback path in Chromium; it is not Safari/Firefox compatibility certification.

[Individual timings and profiles](benchmarks/export-comparison.json) include every final paired run. The earlier 15.90 s regression figure comes from a separate paired batch; the 27.6% speed claim uses only the final same-batch comparison.

## Why it is faster without weakening verification

1. **Task yielding replaces timer delays.** Frequent nested `setTimeout(0)` calls were adding minimum timer delays. The UI now uses [scheduler.yield](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) when available and a MessageChannel task otherwise. It continues yielding for rendering/input, with no new library dependency. [js/app.js:27](https://github.com/Kamuros/wh3-trait-editor/blob/298fd608b5cafff5dc70f3071ac2c73d75631fd7/js/app.js#L27).
2. **Record-length reads avoid temporary objects.** The scanner retains truncation, length and exact-integer checks but no longer allocates a result object for each record/array. The root-header reader remains unchanged. Both paths have oversized-length regression tests. [js/esf.js:193](https://github.com/Kamuros/wh3-trait-editor/blob/298fd608b5cafff5dc70f3071ac2c73d75631fd7/js/esf.js#L193).
3. **One complete final read-back replaces duplicate decompression.** Previously the newly compressed campaign was decoded once during construction, then again during final verification. Final verification now checks every decompressed byte, so the earlier decode is redundant. Construction is explicitly unverified until `verify()` succeeds; the UI still refuses to download on any verification problem. [js/savefile.js:185](https://github.com/Kamuros/wh3-trait-editor/blob/298fd608b5cafff5dc70f3071ac2c73d75631fd7/js/savefile.js#L185), [js/app.js:169](https://github.com/Kamuros/wh3-trait-editor/blob/298fd608b5cafff5dc70f3071ac2c73d75631fd7/js/app.js#L169).

The faulty-encoder regression test produces a valid compressed stream with an unrelated byte changed. Final verification rejects it even though the character keys still look correct. A damaged compressed stream is also rejected. This tests the invariant that matters: no unverified bytes reach the download flow. [tests/compressed-roundtrip.cjs:1](https://github.com/Kamuros/wh3-trait-editor/blob/298fd608b5cafff5dc70f3071ac2c73d75631fd7/tests/compressed-roundtrip.cjs#L1).

## Safety, stability and usability

| Area | Before | After |
| --- | --- | --- |
| Unrelated output changes | Character-key verification could overlook them | Every logical-container byte checked; unrelated-change fault injection rejected |
| Unknown patches / incomplete parsing | Could proceed to editing | Read-only outside observed build or with incomplete parsing |
| Trait grouping | Advanced grouping could mix subtypes | Editable grouping and core membership checks restricted to the observed subtype field |
| Completion feedback | Off-screen progress; claimed file was downloaded | Adjacent stage progress; says download was requested; working retry link |
| Failures | Basic error text | Verified recovery restores controls and removes stale download links |
| Source preservation | New output filename | Same; no-edit identity and edited-field binary diffs remain tested |
| Correctness coverage | Limited samples | Seeded binary properties, fixed synthetic fixtures, compressed-path fault injection and real-save browser checks |
| Dependencies | Existing locally bundled libraries | No additional runtime dependencies |

All core test suites passed after the optimization. Browser checks additionally cover download retry, forced verification failure, per-field revert, translated/hostile name strings, memory-only state, local-only requests, 320 px reflow and keyboard-focus smoke checks.

## What is still not established

- In-game loading, recomputed effects and DLC/mod eligibility need game-side verification. Structural success is not a guarantee of game semantics.
- Only one real game build/save has been supplied. Synthetic fixtures are not a multi-version real-save corpus.
- Remaining 0.7–0.9 s main-thread pauses need a separate worker-based change. Lower total runtime does not remove every pause.
- No undo/redo history, crash recovery or cross-tab coordination. The open items in the [review](review-2026-11-12.md), including imported-pack resource exhaustion and full accessibility testing, remain open.
- No evidence here supports broad claims such as “fully stable,” “all mods supported,” or “faster on every device.” The evidence supports faster export on the supplied workload, stronger fail-closed checks and clearer feedback.

## Reproduce

Run the dependency-free core suites:

```sh
node tests/esf-format.cjs
node tests/player-faction.cjs
node tests/localisation.cjs
node tests/roundtrip.cjs
node tests/compressed-roundtrip.cjs
```

The optional browser benchmark requires an existing Playwright/Chromium test environment. No browser-testing dependency is added to the application. Prepare `before/` and `final/` snapshots under a scratch directory from the commits above, then run:

```sh
BENCH_ROOT=/absolute/path/to/snapshots BENCH_SAVE=/absolute/path/to/sample.save node tests/benchmark-browser.cjs before final
```

`BENCH_TRAIT` selects the same replacement key in both versions (default is the Tomb Herald replacement used for this sample). `CHROME_BIN` selects Chromium, and `BENCH_RUNS` defaults to 3. The tool uses localhost port 8767 and writes results into the scratch directory. Download hashes are compared locally; do not commit private saves or generated downloads. A snapshot named `fallback` forces the MessageChannel path for testing.
