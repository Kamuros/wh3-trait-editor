# Observed WH3 save format

These observations come from one supplied WH3 save. They establish structural compatibility with that sample, not all game versions or in-game acceptance. The save and derived binary files are not included in this repository.

## Container layout

The original file is 10,133,100 bytes. Its first four bytes are `CB AB 00 00`, the little-endian integer `0xABCB` (called CBAB by RPFM). Both the outer container and its decompressed campaign use this signature.

| Offset | Meaning in this sample |
| --- | --- |
| 0 | Four-byte signature |
| 4 | Unknown u32, zero |
| 8 | Creation timestamp u32 |
| 12 | String-table offset u32: 10,131,976 in the outer file |
| 16 | Root record begins |

The footer contains record names, UTF-16 strings and ASCII/UTF-8 key strings with explicit u32 indices. Record-name count and name lengths are u16. Value-string counts are u32. **Value-string lengths are u32 in ABCB, versus u16 in ABCA.** UTF-16 lengths count code units; key-string lengths count bytes. Both tables end exactly at the end of each observed container.

This width difference explains the original load failure. Accepting the new signature alone would still misread the tables.

Reference: [RPFM CBAB implementation](https://github.com/Frodo45127/rpfm/blob/576f3973422daad445c9fd28201552f5a002def1/rpfm_lib/src/files/esf/cbab.rs).

## Compression

The outer `CAMPAIGN_SAVE_GAME/COMPRESSED_DATA` record contains an 8,331,574-byte raw LZMA1 stream at offset 1,800,387. Its info record gives an uncompressed length of 82,514,992 bytes and properties `5d 00 00 04 00` (lc=3, lp=0, pb=2, dictionary=262,144 bytes).

Decompression produces a complete second ESF container, including its own header and tables. Its footer starts at 80,908,161. Python's standard-library LZMA decoder independently produced exactly the same bytes as the JavaScript decoder.

| Observation | Outer | Campaign |
| --- | ---: | ---: |
| Record names | 10 | 1,298 |
| Key strings | 27 | 29,664 |
| UTF-16 strings | 3 | 390 |
| Scanner record visits | 20 | 2,629,220 |
| Unknown / malformed / partially skipped records | 0 | 0 |

## Characters and traits

The scanner finds 16,134 records containing innate-like keys under:

`CAMPAIGN_SAVE_GAME/CAMPAIGN_ENV/CAMPAIGN_MODEL/WORLD/FAMILY_TREE/FAMILY_MEMBER/CHARACTER_DETAILS`

This is a family-tree collection, not a verified list of active heroes. There are 732 distinct innate-like keys in the campaign's string table.

Observed direct child field ordinals (zero-based node positions, not byte offsets):

- 12: agent type.
- 13: agent subtype; 422 distinct values in the captured records.
- 28: appearance/art-set key, not agent subtype.
- 3 and 29: faction-like keys; their precise meanings remain unverified.

The previous dependency heuristic selected field 28 because some subtypes occur with multiple agent types. Detection now prefers the observed adjacent subtype field when its position and key shape match. Other layouts still use the heuristic and can be overridden in the UI.

Faction display currently relies on an ancestor `FACTION` record. These family-tree records have no such ancestor, so the faction column remains unknown. Active status, faction-field semantics, and name resolution need further investigation.

A sampled character has two references to the same innate key. The editor updates both existing u32 indices; it does not add strings or rewrite the campaign's other fields.

## Validation performed

- Both containers parsed with no reported malformed records, unknown types, or leftover table bytes.
- A no-change build returned byte-identical original bytes.
- One synthetic trait substitution on the real save rebuilt, decompressed and re-parsed successfully.
- The decompressed output differed only within the selected character's two four-byte references (four actual byte values changed).
- Character verification and scanner statistics matched expectations after editing.
- The resulting test output was 10,625,729 bytes; the custom encoder produces different compressed bytes and may increase size.
- Synthetic tests cover ABCA/ABCB string widths, Unicode, strings over 65,535 bytes, truncation, unsupported signatures, and subtype selection.

These checks do not establish whether the game accepts the output or recalculates trait effects. Browser interaction was not tested in this investigation. Test an edited copy in game before relying on it.
