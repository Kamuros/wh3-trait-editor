/*
 * Reader for the "ABCA" ESF container used by Total War save files.
 *
 * It does not build a node tree. It walks the structure once, collects only what
 * the editor needs, and remembers where the size fields are so that a compressed
 * block can later be swapped without re-serialising anything else.
 *
 * Layout knowledge comes from EditSF's EsfLibrary and RPFM's ESF module (from
 * memory, not verified against a Warhammer III save). Anything that does not
 * match is contained per record and reported in the scan statistics.
 */
(function (global) {
  'use strict';

  const CONFIG = Object.freeze({
    anchorRecord: 'CHARACTER_DETAILS',      // record that represents one character
    contextRecord: 'FACTION',               // nearest ancestor used as a display hint
    compressedRecord: 'COMPRESSED_DATA',
    compressedInfoRecord: 'COMPRESSED_DATA_INFO',
    innatePattern: /_skill_innate_/,        // innate traits are background skills
  });

  const SIGNATURE_ABCA = 0xABCA;
  const HEADER_SIZE = 16;
  const FOOTER_OFFSET_POS = 12;
  const MAX_DEPTH = 512;
  const MAX_DIRECT_STRINGS = 200;
  const MAX_TEXT_HINTS = 6;

  const T_UTF16 = 0x0e, T_ASCII = 0x0f, T_U8_ARRAY = 0x46;
  const KIND_NONE = 0, KIND_COMPRESSED = 1, KIND_COMPRESSED_INFO = 2, KIND_ANCHOR = 3, KIND_CONTEXT = 4;

  // Payload size per node type: >= 0 fixed, -2 length-prefixed array, -1 unknown.
  const PRIM_SIZE = new Int8Array(256).fill(-1);
  (function () {
    const fixed = {
      0x01: 1, 0x02: 1, 0x03: 2, 0x04: 4, 0x05: 8, 0x06: 1, 0x07: 2, 0x08: 4, 0x09: 8,
      0x0a: 4, 0x0b: 8, 0x0c: 8, 0x0d: 12, 0x0e: 4, 0x0f: 4, 0x10: 2,
      0x12: 0, 0x13: 0, 0x14: 0, 0x15: 0, 0x16: 1, 0x17: 2, 0x18: 3,
      0x19: 0, 0x1a: 1, 0x1b: 2, 0x1c: 3, 0x1d: 0,
      0x21: 4, 0x23: 1, 0x24: 2, 0x25: 4,
    };
    for (const key in fixed) PRIM_SIZE[Number(key)] = fixed[key];
    for (let t = 0x40; t <= 0x5d; t++) if (t !== 0x51) PRIM_SIZE[t] = -2;
  })();

  const latin1 = new TextDecoder('latin1');
  const utf16le = new TextDecoder('utf-16le');

  function nameKind(name) {
    if (name === CONFIG.anchorRecord) return KIND_ANCHOR;
    if (name === CONFIG.contextRecord) return KIND_CONTEXT;
    if (name === CONFIG.compressedRecord) return KIND_COMPRESSED;
    if (name === CONFIG.compressedInfoRecord) return KIND_COMPRESSED_INFO;
    return KIND_NONE;
  }

  /** Reads the header, the record-name table and both string tables. */
  function parseContainer(buf) {
    if (buf.length < HEADER_SIZE + 8) throw new Error('file is too small to be an ESF container');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const signature = dv.getUint32(0, true);
    if (signature !== SIGNATURE_ABCA) {
      throw new Error(`unsupported container signature 0x${signature.toString(16).toUpperCase()} (expected 0xABCA)`);
    }
    const footerOffset = dv.getUint32(FOOTER_OFFSET_POS, true);
    if (footerOffset < HEADER_SIZE + 4 || footerOffset >= buf.length) {
      throw new Error('record-name table offset is out of range');
    }

    const names = [], utf16 = new Map(), ascii = new Map(), asciiIndex = new Map();
    let p = footerOffset;
    try {
      const nameCount = dv.getUint16(p, true); p += 2;
      for (let i = 0; i < nameCount; i++) {
        const len = dv.getUint16(p, true); p += 2;
        names.push(latin1.decode(buf.subarray(p, p + len))); p += len;
      }
      const utf16Count = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < utf16Count; i++) {
        const len = dv.getUint16(p, true) * 2; p += 2;
        const text = utf16le.decode(buf.subarray(p, p + len)); p += len;
        utf16.set(dv.getUint32(p, true), text); p += 4;
      }
      const asciiCount = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < asciiCount; i++) {
        const len = dv.getUint16(p, true); p += 2;
        const text = latin1.decode(buf.subarray(p, p + len)); p += len;
        const index = dv.getUint32(p, true); p += 4;
        ascii.set(index, text);
        if (!asciiIndex.has(text)) asciiIndex.set(text, index);
      }
    } catch (err) {
      if (err instanceof RangeError) throw new Error('string tables are truncated or not in the expected layout');
      throw err;
    }
    return { buf, dv, footerOffset, names, utf16, ascii, asciiIndex, trailingBytes: buf.length - p };
  }

  function readVarAt(buf, pos) {
    let value = 0, len = 0, b;
    do {
      b = buf[pos + len++];
      value = value * 128 + (b & 0x7f);
    } while ((b & 0x80) && len < 9);
    return { value, len };
  }

  function encodeVar(value) {
    const bytes = [value % 128];
    value = Math.floor(value / 128);
    while (value > 0) {
      bytes.unshift((value % 128) | 0x80);
      value = Math.floor(value / 128);
    }
    return Uint8Array.from(bytes);
  }

  /*
   * The root record header is the one place where the references disagree, so
   * every known layout is tried and accepted only if it ends exactly at the footer.
   */
  function parseRootHeader(seg) {
    const { buf, dv, footerOffset, names } = seg;
    const type = buf[HEADER_SIZE];
    if ((type & 0xC0) !== 0x80) throw new Error(`root node is not a record (type 0x${type.toString(16)})`);

    const tryVar = (nameIdx, sizePos) => {
      if (nameIdx >= names.length) return null;
      const size = readVarAt(buf, sizePos);
      if (sizePos + size.len + size.value !== footerOffset) return null;
      return { nameIdx, sizePos, sizeLen: size.len, sizeVal: size.value, kind: 'var', bodyStart: sizePos + size.len };
    };
    const shortIdx = ((type & 1) << 8) | buf[HEADER_SIZE + 1];
    const longIdx = dv.getUint16(HEADER_SIZE + 1, true);

    let root = null;
    if (!(type & 0x20)) root = tryVar(shortIdx, HEADER_SIZE + 2);
    if (!root) root = tryVar(longIdx, HEADER_SIZE + 4);
    if (!root && longIdx < names.length && dv.getUint32(HEADER_SIZE + 4, true) === footerOffset) {
      root = { nameIdx: longIdx, sizePos: HEADER_SIZE + 4, sizeLen: 4, sizeVal: footerOffset, kind: 'abs32', bodyStart: HEADER_SIZE + 8 };
    }
    if (!root) throw new Error('root record header is not in a recognised layout');
    return root;
  }

  function readUInt(seg, type, pos) {
    switch (type) {
      case 0x04: case 0x08: return seg.dv.getUint32(pos, true);
      case 0x14: case 0x19: return 0;
      case 0x15: return 1;
      case 0x16: case 0x1a: return seg.buf[pos];
      case 0x17: case 0x1b: return seg.buf[pos] | (seg.buf[pos + 1] << 8);
      case 0x18: case 0x1c: return seg.buf[pos] | (seg.buf[pos + 1] << 8) | (seg.buf[pos + 2] << 16);
      default: return null;
    }
  }

  /**
   * Walks one container. Returns the characters (anchor records holding an innate
   * key), the compressed blocks, and statistics about anything not understood.
   */
  function scan(seg) {
    const { buf, dv, names, ascii, utf16 } = seg;
    const kindOfName = names.map(nameKind);
    const innate = new Set();
    for (const [index, text] of ascii) if (CONFIG.innatePattern.test(text)) innate.add(index);

    const stats = {
      records: 0, partialRecords: 0, malformedRecords: 0, incompleteCompressed: 0,
      unknownTypes: new Map(), strayInnate: new Map(), innateStrings: innate.size,
    };
    const characters = [], compressed = [];
    const fieldMap = new Map();
    const headerField = { pos: FOOTER_OFFSET_POS, len: 4, value: seg.footerOffset, kind: 'abs32', parent: null };

    // Record stack, kept in parallel arrays to avoid allocating per record.
    const sName = new Int32Array(MAX_DEPTH), sKind = new Uint8Array(MAX_DEPTH), sFirstAscii = new Int32Array(MAX_DEPTH);
    const sSizePos = new Float64Array(MAX_DEPTH), sSizeLen = new Uint8Array(MAX_DEPTH), sSizeVal = new Float64Array(MAX_DEPTH);
    const sBlkPos = new Float64Array(MAX_DEPTH), sBlkLen = new Uint8Array(MAX_DEPTH), sBlkVal = new Float64Array(MAX_DEPTH);
    const sCap = new Array(MAX_DEPTH).fill(null);
    let depth = -1, anchorDepth = -1, anchorCap = null, rootKind = 'var', vp = 0;

    function readVar(pos) {
      let value = 0, n = 0, b;
      do {
        b = buf[pos++];
        value = value * 128 + (b & 0x7f);
      } while ((b & 0x80) && ++n < 9);
      vp = pos;
      return value;
    }

    function pathString(upTo) {
      const parts = [];
      for (let k = 0; k <= upTo; k++) parts.push(names[sName[k]]);
      return parts.join('/');
    }

    function getField(pos, len, value, kind) {
      let field = fieldMap.get(pos);
      if (!field) fieldMap.set(pos, field = { pos, len, value, kind, parent: null });
      return field;
    }

    function finishCharacter() {
      const cap = anchorCap;
      if (!cap.occ.length) return;
      const offsets = [], indices = [], keys = new Set();
      for (let i = 0; i < cap.occ.length; i += 2) {
        offsets.push(cap.occ[i]);
        indices.push(cap.occ[i + 1]);
        keys.add(ascii.get(cap.occ[i + 1]));
      }
      const direct = new Map();
      for (let i = 0; i < cap.direct.length; i += 2) direct.set(cap.direct[i], ascii.get(cap.direct[i + 1]) || '');
      let context = '';
      for (let k = depth - 1; k >= 0; k--) {
        if (sKind[k] === KIND_CONTEXT) {
          if (sFirstAscii[k] >= 0) context = ascii.get(sFirstAscii[k]) || '';
          break;
        }
      }
      characters.push({ segment: seg, offsets, indices, innateKeys: [...keys], direct, texts: cap.texts, path: pathString(depth), context });
    }

    function finishCompressed(cap) {
      if (!cap.arr || !cap.info || cap.info.size === null || !cap.info.props) {
        stats.incompleteCompressed++;
        return;
      }
      const chain = [getField(cap.arr.lenPos, cap.arr.lenLen, cap.arr.len, 'var')];
      for (let k = depth; k >= 0; k--) {
        chain.push(getField(sSizePos[k], sSizeLen[k], sSizeVal[k], k === 0 ? rootKind : 'var'));
        if (sBlkPos[k] >= 0) chain.push(getField(sBlkPos[k], sBlkLen[k], sBlkVal[k], 'var'));
      }
      chain.push(headerField);
      for (let i = 0; i < chain.length - 1; i++) chain[i].parent = chain[i + 1];
      compressed.push({
        dataStart: cap.arr.dataStart, dataLen: cap.arr.len, lenField: chain[0],
        props: cap.info.props, uncompressedSize: cap.info.size, path: pathString(depth),
      });
    }

    function push(nameIdx, sizePos, sizeLen, sizeVal, blkPos, blkLen, blkVal) {
      depth++;
      sName[depth] = nameIdx; sFirstAscii[depth] = -1;
      sSizePos[depth] = sizePos; sSizeLen[depth] = sizeLen; sSizeVal[depth] = sizeVal;
      sBlkPos[depth] = blkPos; sBlkLen[depth] = blkLen; sBlkVal[depth] = blkVal;
      const kind = kindOfName[nameIdx];
      sKind[depth] = kind;
      stats.records++;
      if (kind === KIND_ANCHOR) {
        if (anchorCap === null) {
          anchorCap = { direct: [], occ: [], texts: [] };
          anchorDepth = depth;
        }
      } else if (kind === KIND_COMPRESSED) {
        sCap[depth] = { arr: null, info: null };
      } else if (kind === KIND_COMPRESSED_INFO) {
        sCap[depth] = { size: null, props: null };
      }
    }

    function pop() {
      const kind = sKind[depth];
      if (depth === anchorDepth) {
        finishCharacter();
        anchorCap = null;
        anchorDepth = -1;
      } else if (kind === KIND_COMPRESSED_INFO) {
        if (depth > 0 && sKind[depth - 1] === KIND_COMPRESSED && !sCap[depth - 1].info) sCap[depth - 1].info = sCap[depth];
        sCap[depth] = null;
      } else if (kind === KIND_COMPRESSED) {
        finishCompressed(sCap[depth]);
        sCap[depth] = null;
      }
      depth--;
    }

    function onAscii(valuePos, ordinal) {
      const index = dv.getUint32(valuePos, true);
      if (sFirstAscii[depth] < 0) sFirstAscii[depth] = index;
      if (anchorCap !== null) {
        if (depth === anchorDepth && anchorCap.direct.length < MAX_DIRECT_STRINGS * 2) anchorCap.direct.push(ordinal, index);
        if (innate.has(index)) anchorCap.occ.push(valuePos, index);
      } else if (innate.has(index)) {
        const path = pathString(depth);
        stats.strayInnate.set(path, (stats.strayInnate.get(path) || 0) + 1);
      }
    }

    function onUtf16(valuePos) {
      if (anchorCap === null || anchorCap.texts.length >= MAX_TEXT_HINTS) return;
      const text = utf16.get(dv.getUint32(valuePos, true));
      if (text && !anchorCap.texts.includes(text)) anchorCap.texts.push(text);
    }

    function onByteArray(lenPos, lenLen, len, dataStart) {
      const kind = sKind[depth], cap = sCap[depth];
      if (kind === KIND_COMPRESSED && !cap.arr) cap.arr = { lenPos, lenLen, len, dataStart };
      else if (kind === KIND_COMPRESSED_INFO && !cap.props) cap.props = buf.slice(dataStart, dataStart + len);
    }

    /*
     * Walks the children of one record. Every record is length-delimited, so on
     * anything unexpected the rest of that record is abandoned and the caller
     * resumes at the record's declared end.
     */
    function walkBody(start, end) {
      let pos = start, ordinal = 0;
      while (pos < end) {
        const type = buf[pos++];
        if (type & 0x80) {
          let nameIdx;
          if (type & 0x20) { nameIdx = buf[pos] | (buf[pos + 1] << 8); pos += 3; }
          else { nameIdx = ((type & 1) << 8) | buf[pos]; pos += 1; }
          if (pos >= end || nameIdx >= names.length || depth + 1 >= MAX_DEPTH) { stats.malformedRecords++; return; }

          if (type & 0x40) {
            const blkPos = pos;
            const blkVal = readVar(pos);
            const blkLen = vp - pos;
            pos = vp;
            const afterSize = pos;
            const count = readVar(pos);
            pos = vp;
            const afterCount = pos;
            for (let i = 0; i < count; i++) {
              const sizePos = pos;
              const sizeVal = readVar(pos);
              const sizeLen = vp - pos;
              pos = vp;
              const bodyEnd = pos + sizeVal;
              if (bodyEnd > end) { stats.malformedRecords++; return; }
              push(nameIdx, sizePos, sizeLen, sizeVal, blkPos, blkLen, blkVal);
              walkBody(pos, bodyEnd);
              pop();
              pos = bodyEnd;
            }
            // The block size is accepted with or without the count field included.
            if (pos > end || (afterCount + blkVal !== pos && afterSize + blkVal !== pos)) { stats.malformedRecords++; return; }
          } else {
            const sizePos = pos;
            const sizeVal = readVar(pos);
            const sizeLen = vp - pos;
            pos = vp;
            const bodyEnd = pos + sizeVal;
            if (bodyEnd > end) { stats.malformedRecords++; return; }
            push(nameIdx, sizePos, sizeLen, sizeVal, -1, 0, 0);
            walkBody(pos, bodyEnd);
            pop();
            pos = bodyEnd;
          }
        } else {
          const size = PRIM_SIZE[type];
          if (size >= 0) {
            if (pos + size > end) { stats.malformedRecords++; return; }
            if (type === T_ASCII) onAscii(pos, ordinal);
            else if (type === T_UTF16) onUtf16(pos);
            else if (sKind[depth] === KIND_COMPRESSED_INFO && sCap[depth].size === null) sCap[depth].size = readUInt(seg, type, pos);
            pos += size;
          } else if (size === -2) {
            const lenPos = pos;
            const len = readVar(pos);
            const lenLen = vp - pos;
            pos = vp;
            if (pos + len > end) { stats.malformedRecords++; return; }
            if (type === T_U8_ARRAY) onByteArray(lenPos, lenLen, len, pos);
            pos += len;
          } else {
            stats.unknownTypes.set(type, (stats.unknownTypes.get(type) || 0) + 1);
            stats.partialRecords++;
            return;
          }
        }
        ordinal++;
      }
    }

    const root = parseRootHeader(seg);
    rootKind = root.kind;
    push(root.nameIdx, root.sizePos, root.sizeLen, root.sizeVal, -1, 0, 0);
    walkBody(root.bodyStart, seg.footerOffset);
    pop();
    return { characters, compressed, stats };
  }

  /**
   * Returns a copy of `buf` in which each compressed block is replaced by new
   * bytes and every enclosing size field (and the footer offset) is adjusted.
   * `replacements` is [{ entry, bytes }], with entries from scan() of this buffer.
   */
  function applyReplacements(buf, replacements) {
    const delta = new Map();
    const edits = [];
    for (const { entry, bytes } of replacements) {
      edits.push({ pos: entry.dataStart, oldLen: entry.dataLen, bytes });
      delta.set(entry.lenField, (delta.get(entry.lenField) || 0) + bytes.length - entry.dataLen);
      for (let f = entry.lenField.parent; f; f = f.parent) if (!delta.has(f)) delta.set(f, 0);
    }
    // Size fields always precede their content, so descending position = innermost first.
    const fields = [...delta.keys()].sort((a, b) => b.pos - a.pos);
    for (const field of fields) {
      const change = delta.get(field);
      if (change === 0) continue;
      const value = field.value + change;
      let bytes;
      if (field.kind === 'var') {
        bytes = encodeVar(value);
      } else {
        bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value, true);
      }
      edits.push({ pos: field.pos, oldLen: field.len, bytes });
      if (field.parent) delta.set(field.parent, delta.get(field.parent) + change + bytes.length - field.len);
    }

    edits.sort((a, b) => a.pos - b.pos);
    let total = buf.length;
    for (const e of edits) total += e.bytes.length - e.oldLen;
    const out = new Uint8Array(total);
    let src = 0, dst = 0;
    for (const e of edits) {
      out.set(buf.subarray(src, e.pos), dst);
      dst += e.pos - src;
      out.set(e.bytes, dst);
      dst += e.bytes.length;
      src = e.pos + e.oldLen;
    }
    out.set(buf.subarray(src), dst);
    return out;
  }

  global.TwEsf = { CONFIG, parseContainer, scan, applyReplacements };
})(window);
