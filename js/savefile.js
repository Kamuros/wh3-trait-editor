/*
 * Save model: loads a save (including compressed sections), derives trait pools
 * from the characters present in the save, and builds/verifies an edited copy.
 */
(function (global) {
  'use strict';

  const Esf = global.TwEsf, Lzma = global.TwLzma;
  const LORD_AGENT_TYPE = 'general';
  const ASCII_NODE = 0x0f;

  async function loadSegment(model, buf, parentLink, label, progress) {
    const seg = Esf.parseContainer(buf);
    const result = Esf.scan(seg);
    seg.label = label;
    seg.parentLink = parentLink;
    seg.children = [];
    seg.scanStats = result.stats;
    seg.metadata = result.metadata;
    model.segments.push(seg);

    for (const ch of result.characters) {
      ch.id = model.characters.length;
      ch.innateKey = ch.innateKeys.length === 1 ? ch.innateKeys[0] : null; // null = ambiguous, never edited
      model.characters.push(ch);
    }

    for (const entry of result.compressed) {
      const child = { entry, segment: null };
      seg.children.push(child);
      try {
        const packed = buf.subarray(entry.dataStart, entry.dataStart + entry.dataLen);
        const raw = await Lzma.decode(packed, entry.props, entry.uncompressedSize,
          (f) => progress(`Decompressing ${entry.path}…`, f));
        await progress(`Reading ${entry.path}…`, 1);
        child.segment = await loadSegment(model, raw, { parent: seg, entry }, entry.path, progress);
      } catch (err) {
        model.problems.push(`Compressed block at ${entry.path} could not be read: ${err.message}`);
      }
    }
    return seg;
  }

  async function load(bytes, progress) {
    const model = { segments: [], characters: [], problems: [], root: null };
    model.root = await loadSegment(model, bytes, null, 'save file', progress);
    const meta = model.segments.map((s) => s.metadata);
    model.playerFaction = meta.find((m) => m.localFaction)?.localFaction || meta.find((m) => m.headerFaction)?.headerFaction || '';
    model.playerFactionLabel = meta.find((m) => m.headerFaction === model.playerFaction && m.factionLabel)?.factionLabel || '';
    for (const seg of model.segments) {
      const roster = new Map();
      for (const entry of seg.metadata.roster) {
        // Duplicate links are ambiguous; never use them to infer ownership.
        roster.set(entry.detailsId, roster.has(entry.detailsId) ? null : entry);
      }
      for (const ch of model.characters.filter((c) => c.segment === seg)) {
        const live = roster.get(ch.detailsId);
        ch.active = Boolean(live && live.characterId === ch.characterId);
        ch.faction = ch.active ? live.faction : (ch.characterId === 0 ? ch.direct.get(3) || '' : '');
        ch.internalCommander = ch.direct.get(12) === 'colonel';
      }
    }
    model.playerCharacters = model.playerFaction ? model.characters.filter((c) => c.faction === model.playerFaction && !c.internalCommander) : [];
    return model;
  }

  function determines(characters, fromOrdinal, toOrdinal) {
    const seen = new Map();
    for (const ch of characters) {
      const from = ch.direct.get(fromOrdinal), to = ch.direct.get(toOrdinal);
      if (from === undefined || to === undefined) continue;
      if (seen.has(from) && seen.get(from) !== to) return false;
      seen.set(from, to);
    }
    return true;
  }

  /*
   * Finds which string fields of the character record hold the agent type and
   * the agent subtype, from the data itself:
   *  - agent type: the field where the value "general" occurs most often;
   *  - subtype: the coarsest always-filled field whose value implies the agent type.
   * The result is shown to the user, who can override the subtype field.
   */
  function detectFields(characters) {
    const stats = new Map();
    for (const ch of characters) {
      for (const [ordinal, value] of ch.direct) {
        let s = stats.get(ordinal);
        if (!s) stats.set(ordinal, s = { ordinal, count: 0, values: new Map() });
        s.count++;
        s.values.set(value, (s.values.get(value) || 0) + 1);
      }
    }

    let typeOrdinal = null, most = 0;
    for (const s of stats.values()) {
      const n = s.values.get(LORD_AGENT_TYPE) || 0;
      if (n > most) { most = n; typeOrdinal = s.ordinal; }
    }

    const candidates = [...stats.values()]
      .filter((s) => s.ordinal !== typeOrdinal && ![...s.values.keys()].some((v) => Esf.CONFIG.innatePattern.test(v)))
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => ({
        ordinal: s.ordinal,
        distinct: s.values.size,
        complete: s.count === characters.length && !s.values.has(''),
        samples: [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0] || '(empty)'),
      }));

    let subtype = null;
    if (typeOrdinal !== null) {
      for (const cand of candidates) {
        if (!cand.complete || cand.distinct < 2) continue;
        if (!determines(characters, cand.ordinal, typeOrdinal)) continue;
        if (!subtype || cand.distinct < subtype.distinct) subtype = cand;
      }
    }
    // In the observed WH3 CHARACTER_DETAILS layout, subtype follows agent type.
    // The same subtype can occur with different agent types, so the generic
    // functional-dependency heuristic can wrongly select an art-set field.
    const adjacent = candidates.find((c) => c.ordinal === typeOrdinal + 1);
    if (typeOrdinal === 12 && adjacent && adjacent.complete &&
        characters.every((ch) => /^wh\d?_/.test(ch.direct.get(adjacent.ordinal)) &&
          !ch.direct.get(adjacent.ordinal).includes('_art_set_'))) subtype = adjacent;
    return { typeOrdinal, subtypeOrdinal: subtype ? subtype.ordinal : null, candidates };
  }

  /** subtype → Map(innate key → number of characters seen with it). */
  function buildPools(characters, subtypeOrdinal) {
    const pools = new Map();
    if (subtypeOrdinal === null) return pools;
    for (const ch of characters) {
      const subtype = ch.direct.get(subtypeOrdinal);
      if (!subtype || !ch.innateKey) continue;
      let pool = pools.get(subtype);
      if (!pool) pools.set(subtype, pool = new Map());
      pool.set(ch.innateKey, (pool.get(ch.innateKey) || 0) + 1);
    }
    return pools;
  }

  /** Traits this character may take: seen on its own subtype and present in its string table. */
  function optionsFor(ch, pools, subtypeOrdinal) {
    if (!ch.innateKey || subtypeOrdinal === null) return [];
    const pool = pools.get(ch.direct.get(subtypeOrdinal));
    if (!pool) return [];
    return [...pool.entries()]
      .filter(([key]) => ch.segment.asciiIndex.has(key))
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  async function buildSegment(seg, editsBySegment, dirty, progress) {
    const replacements = [];
    for (const child of seg.children) {
      if (!child.segment || !dirty.has(child.segment)) continue;
      const raw = await buildSegment(child.segment, editsBySegment, dirty, progress);
      if (raw.length !== child.entry.uncompressedSize) {
        throw new Error('edits inside nested compressed blocks are not supported');
      }
      const packed = await Lzma.encode(raw, child.entry.props, (f) => progress('Compressing edited data…', f));
      const check = await Lzma.decode(packed, child.entry.props, raw.length, (f) => progress('Checking compressed data…', f));
      if (!bytesEqual(check, raw)) {
        throw new Error('self-check failed: recompressed data does not decode back to the edited data');
      }
      replacements.push({ entry: child.entry, bytes: packed });
    }

    const own = editsBySegment.get(seg) || [];
    if (!own.length && !replacements.length) return seg.buf;

    let buf = seg.buf;
    if (own.length) {
      buf = seg.buf.slice();
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (const { ch, key } of own) {
        const newIndex = seg.asciiIndex.get(key);
        if (newIndex === undefined) throw new Error(`"${key}" is not in this character's string table`);
        ch.offsets.forEach((offset, i) => {
          if (buf[offset - 1] !== ASCII_NODE || dv.getUint32(offset, true) !== ch.indices[i]) {
            throw new Error(`unexpected data at offset ${offset}; refusing to patch`);
          }
          dv.setUint32(offset, newIndex, true);
        });
      }
    }
    return replacements.length ? Esf.applyReplacements(buf, replacements) : buf;
  }

  /** edits: Map(character → new innate key). Returns the bytes of the edited save. */
  async function build(model, edits, progress) {
    const editsBySegment = new Map(), dirty = new Set();
    for (const [ch, key] of edits) {
      if (!ch.innateKey) throw new Error('attempted to edit an ambiguous character');
      if (!editsBySegment.has(ch.segment)) editsBySegment.set(ch.segment, []);
      editsBySegment.get(ch.segment).push({ ch, key });
      for (let s = ch.segment; s; s = s.parentLink ? s.parentLink.parent : null) dirty.add(s);
    }
    return buildSegment(model.root, editsBySegment, dirty, progress);
  }

  /** Re-reads the produced file from scratch and compares every character. Returns a list of problems. */
  async function verify(outputBytes, model, edits, progress) {
    const check = await load(outputBytes, (label, f) => progress(`Verifying: ${label}`, f));
    const problems = check.problems.slice();
    if (check.characters.length !== model.characters.length) {
      problems.push(`character count changed (${model.characters.length} → ${check.characters.length})`);
      return problems;
    }
    model.characters.forEach((orig, i) => {
      const got = check.characters[i];
      const expected = edits.has(orig) ? edits.get(orig) : orig.innateKeys.join('|');
      if (got.innateKeys.join('|') !== expected || got.path !== orig.path) {
        problems.push(`character #${i} reads back as "${got.innateKeys.join('|')}", expected "${expected}"`);
      }
    });
    return problems;
  }

  global.TwSave = { LORD_AGENT_TYPE, load, detectFields, buildPools, optionsFor, build, verify };
})(window);
