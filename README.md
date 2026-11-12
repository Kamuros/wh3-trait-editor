# WH3 Trait Editor

A browser-based innate trait editor focused on your player faction in Total War: WARHAMMER III. Files are processed locally; no save or language file is uploaded.

**Parsing, faction selection, browser interaction and an edit/rebuild round trip have been checked with one real WH3 save. In-game loading remains unverified. Keep backups and use copies.**

## Use the editor

Open `index.html` locally, or visit the repository’s GitHub Pages site:

https://kamuros.github.io/wh3-trait-editor/

1. Choose a `.save` file. The editor reads the local player faction from the save and shows its active heroes and lords with innate traits.
2. Optionally load game language files to resolve character names, character types and traits. Without them, labels are simplified from IDs and unavailable names are marked explicitly.
3. Choose a new trait, then **Verify and download edited save**.
4. Load the edited copy in game and check the trait and its effects. Save and reload before relying on it.

Windows saves are normally under `%APPDATA%\The Creative Assembly\Warhammer3\save_games`.

The default view excludes other factions, internal colonel records, and reserve/inactive records. Use **Include reserve / inactive records** to see additional records assigned to your faction. These may include recruitment candidates; their exact status is not inferred.

Alternatives are innate traits observed on the same character subtype elsewhere in the save. This provides more options than restricting the pool to your own roster, but is not a complete database or proof of every game eligibility rule. Only your faction’s characters can be selected for editing in the interface.

## Actual in-game names

Saves often store `names_name_...` references instead of the displayed name. The editor cannot recover those names from an ID alone.

Under **Show in-game names and trait labels**, select `local_en.pack` or the equivalent `local_*.pack` for your language from:

`Steam/steamapps/common/Total War WARHAMMER III/data`

Supported inputs:

- Ordinary, unencrypted PFH5 language packs, including Zstandard-compressed `.loc` entries.
- Exported `.loc` language tables (version 1).
- RPFM localisation TSV exports with key and text in the first two columns.

You can select multiple files. Later imported entries override earlier ones, allowing mod translations. The importer reads pack indexes and language entries rather than loading unrelated pack contents. Language tables are limited to 128 MB each. Encrypted or extended pack headers are rejected with an explanation; export their localisation tables instead.

Language data stays in memory for the current page session. Explicit custom-name text in the save is used directly. Missing translations retain clearly identified fallbacks. Internal keys are available on hover and in Technical details.

## Compatibility and export feedback

Only `v9.0.5 Build 51143.4399233` is currently enabled for editing, based on one structurally tested modded sample. Other builds or partially parsed saves are read-only. This does not establish in-game or mod/DLC compatibility.

Export shows progress beside the button and keeps a **Download again** link until you change selections. Success confirms the file was prepared and download requested, not that the browser saved it to disk. Close the game before copying an edited save, keep backups, and consider cloud-sync conflicts. Selections exist only in the current tab.

Limits: 64 MiB input, 256 MiB total expanded bytes, eight containers. Larger accepted files may take longer and use considerably more memory. See the [review, findings and performance targets](docs/review-2026-11-12.md) and the [measured before/after comparison](docs/before-after.md).

## Development and validation

Plain HTML, CSS and JavaScript; no build step or package installation is needed. For a local HTTP preview:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`. In VS Code, a local static preview extension also works.

Regression tests require Node.js 18 or newer:

```sh
node tests/esf-format.cjs
node tests/player-faction.cjs
node tests/localisation.cjs
node tests/roundtrip.cjs
node tests/compressed-roundtrip.cjs
```

Tests use synthetic fixtures, including compressed/uncompressed language packs, Unicode, name translation, current faction ownership, transferred characters, reserves and malformed data. The supplied real save was additionally checked locally for player-only display and verified export. No user save or game language data is included in the repository.

See [observed save structure](docs/save-format.md) for format details and remaining limits. The original Python prototype remains in Git history.

## GitHub Pages

In **Settings → Pages**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**. Future pushes to `main` update the site after deployment.

## License

MIT; see [LICENSE](LICENSE). The bundled Zstandard decoder has its own [MIT notice](js/vendor/fzstd-LICENSE.txt); see [third-party dependencies](THIRD_PARTY.md).

Unofficial fan tool, unaffiliated with Creative Assembly or Games Workshop.
