# WH3 Innate Editor

Experimental Python command-line tool for changing a character’s innate trait in a Total War: WARHAMMER III save.

This repository preserves the AI-assisted prototype as supplied. It has **not been validated against a real WH3 save or in game**. Structural checks cannot establish that the format assumptions or resulting game effects are correct. Keep backups and work on copies.

## Requirements

Python 3.8 or newer with the standard-library `lzma` module. No third-party Python packages are required. RPFM is needed separately to export the game database tables used to build a trait pool.

## Usage

Saves are normally under `%APPDATA%\The Creative Assembly\Warhammer3\save_games` on Windows. Replace example paths, character numbers, and trait keys with your own values.

First inspect a copy of a save (read-only):

```sh
python wh3_innate.py inspect mysave.save
```

In RPFM, export `character_skills_tables`, `character_skill_node_sets_tables`, and `character_skill_nodes_tables` from the game database to TSV files. Build a pool using those exports:

```sh
python wh3_innate.py build-pool --skills character_skills.tsv --node-sets character_skill_node_sets.tsv --nodes character_skill_nodes.tsv --out pool.json
```

Each table argument accepts multiple exports, including mod exports. Pool construction excludes nodes restricted to a faction, subculture, or campaign; roll weights and gender restrictions are not evaluated.

List characters and inspect one character’s available traits:

```sh
python wh3_innate.py list mysave.save --pool pool.json --filter captain
python wh3_innate.py list mysave.save --pool pool.json --char 137
```

Character numbers follow their order in that exact save. Use the subtype and name keys to identify the intended character.

Write an edited copy to a new filename, replacing `TRAIT_KEY` with a key shown by `list`:

```sh
python wh3_innate.py set mysave.save mysave_edited.save --pool pool.json --char 137 --trait TRAIT_KEY
```

The tool rejects an existing output filename, changes an ASCII string-table reference, rebuilds compression when needed, and re-parses the result before writing. These checks do not prove game compatibility.

See command-specific options with `python wh3_innate.py COMMAND --help`.

## Verification status

| Area | Status |
| --- | --- |
| Python syntax and command help | Checked during repository preparation |
| Pool generation | Checked with synthetic TSV fixtures only |
| Parsing a real WH3 save | Unverified |
| Pool accuracy against the game database | Unverified |
| Edited save loads and applies trait effects | Unverified |

The prototype assumes CAAB ESF containers, at most one LZMA `COMPRESSED_DATA` block containing a standalone ESF, and an innate skill key inside `CHARACTER_DETAILS`. Some node decoding rules are heuristic. Recompression and effect recalculation by the game remain unverified.

Game saves, database exports, generated pools, and local environment files are excluded by `.gitignore`. No game data is included.
