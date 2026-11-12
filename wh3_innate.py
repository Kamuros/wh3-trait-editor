#!/usr/bin/env python3
"""wh3_innate.py - change a character's innate trait in a Total War: WARHAMMER III save.

Only traits listed for the character's own agent subtype in a pool file (built from
the game's DB tables) are accepted. The source save is never modified.

Format knowledge is recalled from RPFM's ESF module and EditSF; it has not been
tested against a real WH3 save. Parsing is strict so wrong assumptions abort.
"""
import argparse
import csv
import json
import lzma
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

# ---------------------------------------------------------------- ESF (CAAB) layout
MAGIC = b"\xCA\xAB\x00\x00"
HEADER_SIZE = 16  # magic, unknown u32, timestamp u32, u32 offset of the record-name table
T_U32, T_UTF16, T_ASCII, T_UNKNOWN_26, T_U8_ARRAY = 0x08, 0x0E, 0x0F, 0x26, 0x46
FIXED_SIZE = {  # payload bytes after the type byte
    0x01: 1, 0x02: 1, 0x03: 2, 0x04: 4, 0x05: 8, 0x06: 1, 0x07: 2, 0x08: 4, 0x09: 8,
    0x0A: 4, 0x0B: 8, 0x0C: 8, 0x0D: 12, 0x0E: 4, 0x0F: 4, 0x10: 2,
    0x12: 0, 0x13: 0, 0x14: 0, 0x15: 0, 0x16: 1, 0x17: 2, 0x18: 3,
    0x19: 0, 0x1A: 1, 0x1B: 2, 0x1C: 3, 0x1D: 0,
    0x21: 4, 0x23: 1, 0x24: 2, 0x25: 4,
}
ARRAY_TYPES = frozenset(range(0x41, 0x51)) | frozenset(range(0x52, 0x5E))
# Sizes for these come from other editors' reverse engineering; reported by `inspect`.
UNVERIFIED_TYPES = frozenset({0x21, 0x23, 0x24, 0x25, 0x26})

CHARACTER_RECORD = "CHARACTER_DETAILS"
COMPRESSED_RECORD = "COMPRESSED_DATA"


class ToolError(Exception):
    pass


def read_varint(buf, pos):
    """CA's big-endian base-128 integer. Returns (value, next position)."""
    value = 0
    while True:
        byte = buf[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos


def encode_varint(value, width=0):
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    out.extend([0x80] * (width - len(out)))
    return bytes(reversed(out))


def resize_varint(old, new_value):
    """Re-encode a size field; keep the original width only if it was padded."""
    old_value, _ = read_varint(old, 0)
    width = 0 if old == encode_varint(old_value) else len(old)
    return encode_varint(new_value, width)


class Capture:
    """A record of interest: its enclosing size fields and every value node below it."""

    def __init__(self, name, path, is_array, regions):
        self.name, self.path, self.is_array = name, path, is_array
        self.regions = regions  # (size field start, body start, body end), outermost first
        self.leaves = []        # (type, node start, payload start, node end)


class WalkState:
    def __init__(self, capture_names, watch):
        self.capture_names, self.watch = capture_names, watch
        self.path, self.regions, self.active = [], [], None
        self.captures = []
        self.record_counts, self.watch_hits, self.unverified = Counter(), Counter(), Counter()


class Esf:
    """One ESF container: the save file itself or the decompressed campaign block."""

    def __init__(self, buf, label):
        self.buf, self.label = buf, label
        if len(buf) < HEADER_SIZE or buf[:4] != MAGIC:
            raise ToolError(f"{label}: expected ESF signature 'ca ab 00 00', "
                            f"found '{bytes(buf[:4]).hex(' ')}'")
        (self.names_offset,) = struct.unpack_from("<I", buf, 12)
        try:
            self._read_tables()
        except (IndexError, struct.error) as exc:
            raise ToolError(f"{label}: name/string tables not laid out as expected ({exc})") from exc

    def _read_tables(self):
        buf, pos = self.buf, self.names_offset
        (count,) = struct.unpack_from("<H", buf, pos)
        pos += 2
        self.names = []
        for _ in range(count):
            (length,) = struct.unpack_from("<H", buf, pos)
            self.names.append(buf[pos + 2:pos + 2 + length].decode("latin-1"))
            pos += 2 + length
        self.utf16, pos = self._read_string_table(pos, 2, "utf-16-le")
        self.ascii_table_offset = pos
        (self.ascii_count,) = struct.unpack_from("<I", buf, pos)
        self.ascii, pos = self._read_string_table(pos, 1, "latin-1")
        if pos != len(buf):
            raise ToolError(f"{self.label}: string tables end at {pos:#x}, file ends at {len(buf):#x}")
        self.ascii_index = {}
        for index, text in self.ascii.items():
            self.ascii_index.setdefault(text, index)

    def _read_string_table(self, pos, char_width, encoding):
        buf = self.buf
        (count,) = struct.unpack_from("<I", buf, pos)
        pos += 4
        table = {}
        for _ in range(count):
            (length,) = struct.unpack_from("<H", buf, pos)
            end = pos + 2 + length * char_width
            (index,) = struct.unpack_from("<I", buf, end)
            table[index] = buf[pos + 2:end].decode(encoding, errors="replace")
            pos = end + 4
        return table, pos

    def _string_at(self, table, payload):
        (index,) = struct.unpack_from("<I", self.buf, payload)
        if index not in table:
            raise ToolError(f"{self.label}: string index {index} at {payload:#x} is not in the table")
        return table[index]

    def ascii_at(self, payload):
        return self._string_at(self.ascii, payload)

    def utf16_at(self, payload):
        return self._string_at(self.utf16, payload)

    def walk(self, capture_names=(), watch_pattern=None):
        """Visit every node, validating all sizes. Returns the WalkState."""
        watch = frozenset()
        if watch_pattern is not None:
            watch = frozenset(i for i, text in self.ascii.items() if watch_pattern.search(text))
        state = WalkState(frozenset(capture_names), watch)
        try:
            if not self.buf[HEADER_SIZE] & 0x80:
                raise ToolError(f"{self.label}: root node is not a record")
            end = self._record(HEADER_SIZE, state, is_root=True)
        except (IndexError, struct.error) as exc:
            raise ToolError(f"{self.label}: ran past the end of the data while parsing ({exc})") from exc
        if end != self.names_offset:
            raise ToolError(f"{self.label}: root record ends at {end:#x}, "
                            f"name table starts at {self.names_offset:#x}")
        return state

    def _record(self, pos, state, is_root=False):
        buf = self.buf
        tag = buf[pos]
        if is_root or tag & 0x20:  # long form: u16 name index, u8 version
            (name_index,) = struct.unpack_from("<H", buf, pos + 1)
            size_pos = pos + 4
        else:                      # short form: version and name index packed in 2 bytes
            name_index = ((tag & 1) << 8) | buf[pos + 1]
            size_pos = pos + 2
        if name_index >= len(self.names):
            raise ToolError(f"{self.label}: record at {pos:#x} uses unknown name index {name_index}")
        name = self.names[name_index]
        is_array = bool(tag & 0x40)
        size, body = read_varint(buf, size_pos)
        end = body + size

        state.record_counts[name] += 1
        state.path.append(name)
        state.regions.append((size_pos, body, end))
        opened = None
        if state.active is None and name in state.capture_names:
            opened = state.active = Capture(name, "/".join(state.path), is_array, list(state.regions))
            state.captures.append(opened)

        if is_array:  # array of records: count, then one sized group per element
            count, pos = read_varint(buf, body)
            for _ in range(count):
                group_size, group_body = read_varint(buf, pos)
                group_end = group_body + group_size
                state.regions.append((pos, group_body, group_end))
                self._children(group_body, group_end, state)
                state.regions.pop()
                pos = group_end
            if pos != end:
                raise ToolError(f"{self.label}: array {'/'.join(state.path)} ends at {pos:#x}, "
                                f"header says {end:#x}")
        else:
            self._children(body, end, state)

        if opened is not None:
            state.active = None
        state.regions.pop()
        state.path.pop()
        return end

    def _children(self, pos, end, state):
        buf = self.buf
        while pos < end:
            kind = buf[pos]
            if kind & 0x80:
                pos = self._record(pos, state)
                continue
            payload = pos + 1
            size = FIXED_SIZE.get(kind)
            if size is not None:
                nxt = payload + size
            elif kind in ARRAY_TYPES:
                size, payload = read_varint(buf, payload)
                nxt = payload + size
            elif kind == T_UNKNOWN_26:
                # Heuristic recalled from RPFM: length-prefixed if the first byte is a
                # non-zero multiple of 8, otherwise 8 bytes. A wrong guess trips the
                # size checks.
                first = buf[payload]
                nxt = payload + (1 + first if first and first % 8 == 0 else 8)
            else:
                raise ToolError(f"{self.label}: unsupported node type {kind:#04x} at {pos:#x} "
                                f"in {'/'.join(state.path)}")
            if kind in UNVERIFIED_TYPES:
                state.unverified[kind] += 1
            if state.active is not None:
                state.active.leaves.append((kind, pos, payload, nxt))
            if kind == T_ASCII and state.watch and struct.unpack_from("<I", buf, payload)[0] in state.watch:
                state.watch_hits["/".join(state.path)] += 1
            pos = nxt
        if pos != end:
            raise ToolError(f"{self.label}: children of {'/'.join(state.path)} end at {pos:#x}, "
                            f"header says {end:#x}")


# ---------------------------------------------------------------- compressed block
def lzma_unpack(props, data, size):
    header = props + struct.pack("<Q", size)  # rebuild a .lzma header so the decoder knows the size
    try:
        out = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(header + bytes(data))
    except lzma.LZMAError as exc:
        raise ToolError(f"LZMA decompression failed: {exc}") from exc
    if len(out) != size:
        raise ToolError(f"decompressed {len(out)} bytes, block header says {size}")
    return out


def lzma_pack(props, data):
    spec = props[0]
    lzma1 = {"id": lzma.FILTER_LZMA1, "lc": spec % 9, "lp": spec // 9 % 5, "pb": spec // 45,
             "dict_size": struct.unpack_from("<I", props, 1)[0]}
    try:
        packed = lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[lzma1])
    except (lzma.LZMAError, ValueError) as exc:
        raise ToolError(f"LZMA compression with the save's own properties failed: {exc}") from exc
    if packed[:5] != props:
        raise ToolError("encoder could not reproduce the save's LZMA properties")
    return packed[13:]  # drop the .lzma header; the save stores props and size separately


class CompressedBlock:
    """COMPRESSED_DATA = [u8 array: LZMA stream, COMPRESSED_DATA_INFO{u32 size, u8[5] props}]."""

    def __init__(self, esf, capture):
        leaves = capture.leaves
        if (capture.is_array or len(leaves) != 3 or leaves[0][0] != T_U8_ARRAY
                or leaves[1][0] != T_U32 or leaves[2][0] != T_U8_ARRAY
                or leaves[2][3] - leaves[2][2] != 5):
            raise ToolError(f"{COMPRESSED_RECORD} does not have the expected "
                            "[u8 array, info{u32, u8[5]}] layout")
        self.esf, self.regions = esf, capture.regions
        _, self.node_start, self.data_start, self.data_end = leaves[0]
        self.size_field = leaves[1][2]
        self.props = bytes(esf.buf[leaves[2][2]:leaves[2][3]])

    def unpack(self):
        (size,) = struct.unpack_from("<I", self.esf.buf, self.size_field)
        return lzma_unpack(self.props, self.esf.buf[self.data_start:self.data_end], size)


# ---------------------------------------------------------------- save model
class Character:
    def __init__(self, index, esf, capture, pool, all_traits):
        self.index = index
        self.fields = [(payload, esf.ascii_at(payload))
                       for kind, _, payload, _ in capture.leaves if kind == T_ASCII]
        self.subtypes = sorted({text for _, text in self.fields if text in pool})
        self.traits = [(payload, text) for payload, text in self.fields if text in all_traits]
        self.names = [text for _, text in self.fields if text.startswith("names_name_")]

    @property
    def problem(self):
        if len(self.subtypes) != 1:
            return f"{len(self.subtypes)} agent subtype keys from the pool found (need exactly 1)"
        if len(self.traits) != 1:
            return f"{len(self.traits)} innate trait fields found (need exactly 1)"
        return None

    @property
    def subtype(self):
        return self.subtypes[0]

    @property
    def trait(self):
        return self.traits[0][1]

    def describe(self, pool):
        if self.problem:
            return f"#{self.index:<5} not editable: {self.problem}"
        return (f"#{self.index:<5} {self.subtype:<42} {self.trait:<52} "
                f"options={len(pool[self.subtype]):<3} {' '.join(self.names)}")


class Save:
    def __init__(self, data, watch_pattern=None):
        wanted = {COMPRESSED_RECORD, CHARACTER_RECORD}
        self.outer = Esf(data, "save file")
        outer_walk = self.outer.walk(wanted, watch_pattern)
        blocks = [c for c in outer_walk.captures if c.name == COMPRESSED_RECORD]
        if len(blocks) > 1:
            raise ToolError(f"{len(blocks)} {COMPRESSED_RECORD} blocks found; only one is supported")
        self.block = CompressedBlock(self.outer, blocks[0]) if blocks else None
        if self.block:
            self.campaign = Esf(self.block.unpack(), "campaign block")
            self.walk = self.campaign.walk(wanted, watch_pattern)
            if self.walk.record_counts[COMPRESSED_RECORD]:
                raise ToolError("nested compressed blocks are not supported")
        else:
            self.campaign, self.walk = self.outer, outer_walk

    def character_captures(self):
        return [c for c in self.walk.captures if c.name == CHARACTER_RECORD]

    def characters(self, pool):
        all_traits = set().union(*pool.values())
        return [Character(i, self.campaign, capture, pool, all_traits)
                for i, capture in enumerate(self.character_captures())]

    def rebuild(self, new_campaign):
        """Return complete save bytes containing `new_campaign`."""
        if self.block is None:
            return new_campaign
        block = self.block
        packed = lzma_pack(block.props, new_campaign)
        if lzma_unpack(block.props, packed, len(new_campaign)) != new_campaign:
            raise ToolError("recompressed campaign block does not decompress to the same bytes")

        out = bytearray(self.outer.buf)
        struct.pack_into("<I", out, block.size_field, len(new_campaign))
        old_len_field = bytes(out[block.node_start + 1:block.data_start])
        node = bytes([T_U8_ARRAY]) + resize_varint(old_len_field, len(packed)) + packed
        edits = [(block.node_start, block.data_end, node)]
        delta = len(node) - (block.data_end - block.node_start)
        for size_pos, body, end in sorted(block.regions, reverse=True):  # innermost first
            old = bytes(out[size_pos:body])
            new = resize_varint(old, end - body + delta)
            edits.append((size_pos, body, new))
            delta += len(new) - len(old)
        for start, end, data in sorted(edits, reverse=True):  # back to front: offsets stay valid
            out[start:end] = data
        struct.pack_into("<I", out, 12, self.outer.names_offset + delta)
        return bytes(out)


def patch_trait(esf, payload, new_key):
    """Point one ASCII field at `new_key`, adding it to the string table if needed."""
    out = bytearray(esf.buf)
    index = esf.ascii_index.get(new_key)
    if index is None:
        if list(esf.ascii) != list(range(esf.ascii_count)):
            raise ToolError("string table is not a plain 0..n-1 list; refusing to add a new string")
        index = esf.ascii_count
        raw = new_key.encode("ascii")
        out += struct.pack("<H", len(raw)) + raw + struct.pack("<I", index)
        struct.pack_into("<I", out, esf.ascii_table_offset, index + 1)
    struct.pack_into("<I", out, payload, index)
    return bytes(out)


# ---------------------------------------------------------------- pool
def load_pool(path):
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ToolError(f"cannot read pool file {path}: {exc}") from exc
    if not isinstance(raw, dict) or not all(isinstance(v, list) for v in raw.values()):
        raise ToolError(f"{path}: expected {{\"agent_subtype\": [\"innate_key\", ...]}}")
    return {subtype: set(traits) for subtype, traits in raw.items()}


def read_tsv(paths, required):
    """Read RPFM TSV exports (header row, '#...' metadata row, data rows)."""
    rows = []
    for path in paths:
        with open(path, newline="", encoding="utf-8-sig") as handle:
            lines = [r for r in csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
                     if r and not r[0].startswith("#")]
        if not lines:
            raise ToolError(f"{path}: no rows")
        header = lines[0]
        missing = [column for column in required if column not in header]
        if missing:
            raise ToolError(f"{path}: missing column(s) {missing}; found {header}")
        rows += [dict(zip(header, line)) for line in lines[1:]]
    return rows


def cmd_build_pool(args):
    skills = read_tsv(args.skills, ("key", "is_background_skill"))
    node_sets = read_tsv(args.node_sets, ("key", "agent_subtype_key"))
    nodes = read_tsv(args.nodes, ("character_skill_key", "character_skill_node_set_key",
                                  "faction_key", "subculture", "campaign_key"))
    background = {r["key"] for r in skills if r["is_background_skill"].strip().lower() == "true"}
    if not background:
        raise ToolError("no rows with is_background_skill = true; this table/version may mark "
                        "innate traits differently")
    subtype_of_set = {r["key"]: r["agent_subtype_key"] for r in node_sets}
    pool, restricted = defaultdict(set), 0
    for row in nodes:
        if row["character_skill_key"] not in background:
            continue
        if row["faction_key"] or row["subculture"] or row["campaign_key"]:
            restricted += 1  # conservative: never offer a trait that may not apply to this character
            continue
        subtype = subtype_of_set.get(row["character_skill_node_set_key"])
        if subtype:
            pool[subtype].add(row["character_skill_key"])
    if not pool:
        raise ToolError("no agent subtype received any innate trait; check the exported tables")
    Path(args.out).write_text(
        json.dumps({k: sorted(v) for k, v in sorted(pool.items())}, indent=1), encoding="utf-8")
    print(f"{args.out}: {len(pool)} agent subtypes, {len(set().union(*pool.values()))} innate traits; "
          f"{restricted} faction/subculture/campaign-restricted nodes skipped")


# ---------------------------------------------------------------- commands
def pick(items, index):
    if not 0 <= index < len(items):
        raise ToolError(f"character #{index} does not exist (0..{len(items) - 1})")
    return items[index]


def cmd_inspect(args):
    save = Save(Path(args.save).read_bytes(), re.compile(args.pattern))
    print(f"save file: {len(save.outer.buf)} bytes, ESF CAAB")
    if save.block:
        print(f"campaign block: LZMA {save.block.data_end - save.block.data_start} -> "
              f"{len(save.campaign.buf)} bytes, props {save.block.props.hex()}")
    else:
        print(f"no {COMPRESSED_RECORD} block: campaign data is stored inline")
    print(f"strings: {save.campaign.ascii_count} ASCII, {len(save.campaign.utf16)} UTF-16")
    print(f"{CHARACTER_RECORD} records: {len(save.character_captures())}")
    for kind, count in sorted(save.walk.unverified.items()):
        print(f"node type {kind:#04x} present {count}x (decoding rule unverified)")
    print(f"ASCII fields matching /{args.pattern}/, by record path:")
    for path, count in save.walk.watch_hits.most_common():
        print(f"  {count:>6}  {path}")
    if args.char is not None:
        capture = pick(save.character_captures(), args.char)
        print(f"strings in {CHARACTER_RECORD} #{args.char}:")
        for n, (kind, _, payload, _) in enumerate(capture.leaves):
            if kind == T_ASCII:
                print(f"  [{n}] ascii {save.campaign.ascii_at(payload)}")
            elif kind == T_UTF16:
                print(f"  [{n}] utf16 {save.campaign.utf16_at(payload)}")


def cmd_list(args):
    pool = load_pool(args.pool)
    characters = Save(Path(args.save).read_bytes()).characters(pool)
    if args.char is not None:
        char = pick(characters, args.char)
        print(char.describe(pool))
        if not char.problem:
            for trait in sorted(pool[char.subtype]):
                print(f"   {'*' if trait == char.trait else ' '} {trait}")
        return
    for char in characters:
        line = char.describe(pool)
        if (args.all or not char.problem) and (not args.filter or args.filter in line):
            print(line)
    editable = [c for c in characters if not c.problem]
    consistent = sum(1 for c in editable if c.trait in pool[c.subtype])
    print(f"{len(editable)} of {len(characters)} characters editable; {consistent} of those currently "
          f"hold a trait from their own subtype's pool (a low share means the pool file is wrong "
          f"or incomplete)")


def cmd_set(args):
    source, target = Path(args.save), Path(args.out)
    if target.exists():
        raise ToolError(f"{target} already exists; choose a new file name")
    pool = load_pool(args.pool)
    save = Save(source.read_bytes())
    before = save.characters(pool)
    char = pick(before, args.char)
    if char.problem:
        raise ToolError(f"character #{char.index} is not editable: {char.problem}")
    if args.trait not in pool[char.subtype]:
        raise ToolError(f"{args.trait} is not in the pool for {char.subtype}; "
                        f"options: {', '.join(sorted(pool[char.subtype]))}")
    if args.trait == char.trait:
        raise ToolError(f"character #{char.index} already has {args.trait}")

    payload = char.traits[0][0]
    new_campaign = patch_trait(save.campaign, payload, args.trait)
    result = save.rebuild(new_campaign)

    # Verify the final bytes exactly as the game will read them.
    check = Save(result)
    expected = [[text for _, text in c.fields] for c in before]
    expected[char.index][[p for p, _ in char.fields].index(payload)] = args.trait
    actual = [[text for _, text in c.fields] for c in check.characters(pool)]
    if (check.campaign.buf != new_campaign or actual != expected
            or check.walk.record_counts != save.walk.record_counts):
        raise ToolError("verification of the rebuilt save failed; nothing was written")

    target.write_bytes(result)
    print(f"#{char.index} {char.subtype}: {char.trait} -> {args.trait}")
    print(f"wrote {target} (re-parsed and structurally verified; NOT verified in game)")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("inspect", help="validate the save structure and show where innate keys live")
    p.add_argument("save")
    p.add_argument("--pattern", default="skill_innate", help="regex for the report (default: %(default)s)")
    p.add_argument("--char", type=int, help=f"dump the strings of one {CHARACTER_RECORD} record")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("build-pool", help="build the trait pool from RPFM TSV exports")
    p.add_argument("--skills", nargs="+", required=True, help="character_skills_tables export(s)")
    p.add_argument("--node-sets", nargs="+", required=True, help="character_skill_node_sets_tables export(s)")
    p.add_argument("--nodes", nargs="+", required=True, help="character_skill_nodes_tables export(s)")
    p.add_argument("--out", default="pool.json")
    p.set_defaults(func=cmd_build_pool)

    p = sub.add_parser("list", help="list characters, their innate trait and pool size")
    p.add_argument("save")
    p.add_argument("--pool", required=True)
    p.add_argument("--filter", help="only show lines containing this text")
    p.add_argument("--all", action="store_true", help="include characters that cannot be edited")
    p.add_argument("--char", type=int, help="show the available traits for one character")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("set", help="write a copy of the save with one innate trait changed")
    p.add_argument("save")
    p.add_argument("out")
    p.add_argument("--pool", required=True)
    p.add_argument("--char", type=int, required=True)
    p.add_argument("--trait", required=True)
    p.set_defaults(func=cmd_set)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except (ToolError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
