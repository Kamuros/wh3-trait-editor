/* Local-only language data. Supports WH3 PFH5 language packs, LOC and RPFM TSV. */
(function (global) {
  'use strict';
  const utf16 = new TextDecoder('utf-16le'), utf8 = new TextDecoder();
  const MAX_BYTES = 128 * 1024 * 1024;
  function parseLoc(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 14 || dv.getUint16(0, true) !== 0xfeff || utf8.decode(bytes.subarray(2, 5)) !== 'LOC' || bytes[5] !== 0 || dv.getUint32(6, true) !== 1) throw new Error('Unsupported language-table header.');
    let p = 14;
    const string = () => {
      if (p + 2 > bytes.length) throw new Error('Language table is truncated.');
      const length = dv.getUint16(p, true) * 2; p += 2;
      if (p + length > bytes.length) throw new Error('Language table is truncated.');
      const value = utf16.decode(bytes.subarray(p, p + length)); p += length; return value;
    };
    const count = dv.getUint32(10, true), table = new Map();
    if (count > bytes.length / 5) throw new Error('Invalid language-table row count.');
    for (let i = 0; i < count; i++) {
      const key = string(), value = string();
      if (p >= bytes.length) throw new Error('Language table is truncated.');
      p++; table.set(key, value);
    }
    return table;
  }
  async function readFile(file) {
    const table = new Map();
    const merge = rows => { for (const [key, value] of rows) table.set(key, value); };
    if (/\.pack$/i.test(file.name)) {
      const head = new Uint8Array(await file.slice(0, 28).arrayBuffer());
      if (head.length !== 28 || utf8.decode(head.subarray(0, 4)) !== 'PFH5') throw new Error('This importer supports PFH5 language packs. You can also load exported .loc or .tsv files.');
      const h = new DataView(head.buffer), flags = h.getUint32(4, true);
      if (flags & (0x80 | 0x10 | 0x100)) throw new Error('Encrypted or extended pack headers are not supported; export its language tables as .loc or .tsv.');
      const start = 28 + h.getUint32(12, true), size = h.getUint32(20, true), count = h.getUint32(16, true);
      if (size > MAX_BYTES || start + size > file.size || count > size / 6) throw new Error('Invalid pack index.');
      const index = new Uint8Array(await file.slice(start, start + size).arrayBuffer());
      const dv = new DataView(index.buffer); let p = 0, dataPos = start + size;
      for (let i = 0; i < count; i++) {
        const entrySize = 5 + ((flags & 0x40) ? 4 : 0);
        if (p + entrySize > size) throw new Error('Truncated pack index.');
        const length = dv.getUint32(p, true); p += 4;
        if (flags & 0x40) p += 4;
        const compressed = index[p++];
        const end = index.indexOf(0, p);
        if (end < 0 || compressed > 1 || dataPos + length > file.size) throw new Error('Invalid pack entry.');
        const name = utf8.decode(index.subarray(p, end)); p = end + 1;
        if (/\.loc$/i.test(name)) {
          if (length > MAX_BYTES) throw new Error('Language table exceeds the 128 MB import limit.');
          let bytes = new Uint8Array(await file.slice(dataPos, dataPos + length).arrayBuffer());
          if (compressed) {
            if (bytes.length < 8) throw new Error('Truncated compressed language table.');
            const expected = new DataView(bytes.buffer).getUint32(0, true);
            if (expected > MAX_BYTES) throw new Error('Expanded language table exceeds the 128 MB import limit.');
            // WH3 pack entries store u32 output length followed by a Zstandard frame.
            const parts = []; let total = 0;
            const decoder = new global.fzstd.Decompress((chunk) => {
              total += chunk.length;
              if (total > expected) throw new Error('Expanded language table exceeds its declared length.');
              parts.push(chunk.slice());
            });
            decoder.push(bytes.subarray(4), true);
            if (total !== expected) throw new Error('Language-table decompression length mismatch.');
            bytes = new Uint8Array(total); let offset = 0;
            for (const part of parts) { bytes.set(part, offset); offset += part.length; }
          }
          merge(parseLoc(bytes));
        }
        dataPos += length;
      }
    } else {
      if (file.size > MAX_BYTES) throw new Error('Language file exceeds the 128 MB import limit.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.loc$/i.test(file.name)) merge(parseLoc(bytes));
      else {
        const text = bytes[0] === 255 && bytes[1] === 254 ? utf16.decode(bytes) : utf8.decode(bytes);
        for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
          if (!line || line.startsWith('#')) continue;
          const [key, value] = line.split('\t');
          if (key && value !== undefined && key !== 'key') table.set(key, value);
        }
      }
    }
    if (!table.size) throw new Error('No language entries found. Select a local_*.pack, .loc, or exported localisation .tsv file.');
    return table;
  }
  function resolve(table, key, seen = new Set()) {
    if (!key || !table.has(key) || seen.has(key) || seen.size > 8) return '';
    seen.add(key);
    return table.get(key).replace(/\{\{tr:([^}]+)\}\}/g, (_, target) => resolve(table, target, new Set(seen)))
      .replace(/\[\[.*?\]\]/g, '').trim();
  }
  function title(text) { return text.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
  function trait(table, key) {
    const found = resolve(table, 'character_skills_localised_name_' + key);
    if (found) return found;
    return title((key.split('_skill_innate_')[1] || key).replace(/^(?:all|tmb|vmp|vco|cst|nag|emp|dwf|brt|hef|def|wef|lzd|skv|grn|bst|chs|nor|ogr|ksl|cth)_/, ''));
  }
  function subtype(table, key) {
    return resolve(table, 'agent_subtypes_onscreen_name_override_' + key) || title(key.replace(/^wh\d?_(?:main|dlc\d+|pro\d+|twa\d+)_/, '').replace(/^[a-z]{3}_/, ''));
  }
  function character(table, ch) {
    const parts = (ch.nameParts || []).filter(p => p.key || p.text);
    const translated = parts.map(p => p.text || resolve(table, p.key));
    if (translated.some(Boolean)) return translated.filter(Boolean).join(' ') + (translated.some(v => !v) ? ' (partial name)' : '');
    return `Name unavailable · #${ch.detailsId ?? ch.id}`;
  }
  global.TwLabels = { parseLoc, readFile, resolve, trait, subtype, character };
})(window);
