# WH3 Trait Editor

Experimental browser-based innate trait editor for Total War: WARHAMMER III saves. This replaces the original Python command-line prototype; that version remains in Git history.

**Not validated against a real WH3 save or in game. Keep backups and use copies.** Parsing and character detection rely on unverified format assumptions, including heuristic field detection. Unknown node types are skipped within their record and reported in Diagnostics. Successful parsing or output verification does not prove game compatibility.

## Run locally

Open `index.html` in a modern browser. No installation, Python, server, or build step is required. In VS Code, open the repository folder and open `index.html` in your browser, or use a local static preview extension.

All save processing runs in your browser. The supplied scripts contain no save-upload functionality or external script dependencies.

## Edit a save

1. Back up your save, then choose or drop a `.save` file. Windows saves are normally in `%APPDATA%\The Creative Assembly\Warhammer3\save_games`.
2. Review Diagnostics and check that the Faction, Type, and Subtype columns look correct. Use **Group trait pools by** to correct inferred grouping when needed.
3. Filter characters and select an alternative innate trait.
4. Click **Build, verify and download** to download an `_edited.save` copy.
5. Load the copy in game, inspect the trait and its effects, then save and reload before relying on it.

Choices come from innate traits already present on characters grouped under the same subtype in that save. This is a subset of available game traits, not a database-derived pool or proof of all eligibility restrictions. Early campaigns may offer few alternatives.

The editor changes existing four-byte trait references. For compressed data, it rebuilds the affected compressed blocks, checks decompression against the intended bytes, and re-reads the finished output. Its custom LZMA encoder may produce larger files than the game does.

## Files

- `index.html`: interface
- `style.css`: styling
- `js/lzma.js`: raw LZMA codec
- `js/esf.js`: ESF parsing and record scanning
- `js/savefile.js`: save model, trait pools, editing and verification
- `js/app.js`: file selection, filters and download handling

## GitHub Pages (optional)

In this repository’s **Settings → Pages**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**. Once GitHub finishes deployment, the expected address is:

https://kamuros.github.io/wh3-trait-editor/

Uploading these files does not itself enable GitHub Pages.

## Verification limits

Repository preparation checks JavaScript syntax and synthetic compression cases. Browser interaction, real saves, inferred subtype accuracy, and in-game loading still require validation. If loading fails or the detected characters look wrong, capture the Diagnostics text.

Game saves and local environment files are excluded by `.gitignore`. No game data is included.

## License

MIT; see [LICENSE](LICENSE). Unofficial fan tool, unaffiliated with Creative Assembly or Games Workshop.
