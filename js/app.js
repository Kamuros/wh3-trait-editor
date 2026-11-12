/* UI wiring only: file handling, filters, the character table and export. */
(function () {
  'use strict';

  const Save = window.TwSave;
  const LOG_PREFIX = '[tw3-trait-editor]';
  const MAX_ROWS = 1000;
  const ALL = '*';
  const el = (id) => document.getElementById(id);

  const state = { fileName: '', model: null, fields: null, subtypeOrdinal: null, pools: new Map(), edits: new Map(), busy: false };

  function progress(label, fraction) {
    el('progress').hidden = false;
    el('progress-label').textContent = label;
    el('bar-fill').style.width = `${Math.round((fraction || 0) * 100)}%`;
    return new Promise((resolve) => setTimeout(resolve, 0)); // let the page repaint
  }

  function setBusy(busy) {
    state.busy = busy;
    el('file').disabled = busy;
    el('subtype-field').disabled = busy;
    el('build').disabled = busy || state.edits.size === 0;
    if (!busy) el('progress').hidden = true;
  }

  function setStatus(id, text, kind) {
    el(id).textContent = text;
    el(id).className = kind || '';
  }

  const agentType = (ch) => (state.fields.typeOrdinal === null ? '' : ch.direct.get(state.fields.typeOrdinal) || '');
  const subtype = (ch) => (state.subtypeOrdinal === null ? '' : ch.direct.get(state.subtypeOrdinal) || '');
  const options = (ch) => Save.optionsFor(ch, state.pools, state.subtypeOrdinal);
  const traitLabel = (key) => (key.split('_skill_innate_')[1] || key).replace(/_/g, ' ');
  const shortPath = (path) => path.split('/').slice(-3).join('/');
  const formatBytes = (n) => `${(n / 1048576).toFixed(1)} MB`;

  async function openFile(file) {
    if (state.busy || !file) return;
    setBusy(true);
    setStatus('status', '');
    setStatus('export-status', '');
    ['summary-section', 'edit-section', 'export-section'].forEach((id) => { el(id).hidden = true; });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await progress('Reading save structure…', 0);
      const model = await Save.load(bytes, progress);
      state.model = model;
      state.fileName = file.name;
      state.edits.clear();
      state.fields = Save.detectFields(model.characters);
      state.subtypeOrdinal = state.fields.subtypeOrdinal;
      fillSubtypeFieldSelect();
      fillFilterSelects();
      refresh();
      el('summary-section').hidden = false;
      el('edit-section').hidden = model.characters.length === 0;
      el('export-section').hidden = model.characters.length === 0;
      setStatus('status', `Loaded ${file.name} (${formatBytes(bytes.length)}).`, 'ok');
    } catch (err) {
      console.error(LOG_PREFIX, 'load failed', err);
      setStatus('status', `Could not read this file: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function refresh() {
    state.pools = Save.buildPools(state.model.characters, state.subtypeOrdinal);
    renderSummary();
    renderTable();
    renderPending();
  }

  function fillSelect(select, entries, selected) {
    select.replaceChildren();
    for (const [value, label] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    if (selected !== undefined) select.value = selected;
  }

  function fillSubtypeFieldSelect() {
    const entries = [['', '(none – editing disabled)']];
    for (const c of state.fields.candidates) {
      entries.push([String(c.ordinal), `field #${c.ordinal} – ${c.distinct} values, e.g. ${c.samples.join(', ')}`]);
    }
    fillSelect(el('subtype-field'), entries, state.subtypeOrdinal === null ? '' : String(state.subtypeOrdinal));
  }

  function fillFilterSelects() {
    const count = (getter) => {
      const counts = new Map();
      for (const ch of state.model.characters) counts.set(getter(ch), (counts.get(getter(ch)) || 0) + 1);
      return [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    };
    fillSelect(el('faction'), [[ALL, 'All']].concat(count((ch) => ch.context).map(([v, n]) => [v, `${v || '(unknown)'} (${n})`])), ALL);
    fillSelect(el('location'), [[ALL, 'All']].concat(count((ch) => ch.path).map(([v, n]) => [v, `…/${shortPath(v)} (${n})`])), ALL);
    el('role').disabled = state.fields.typeOrdinal === null;
    if (state.fields.typeOrdinal === null) el('role').value = 'all';
  }

  function renderSummary() {
    const { model, fields } = state;
    const chars = model.characters;
    const editable = chars.filter((ch) => options(ch).length > 1).length;
    const lines = [`${chars.length} character record(s) with an innate trait found; ${editable} have at least one alternative in their pool.`];
    if (!chars.length) {
      lines.push('Nothing editable was recognised. Open Diagnostics below – it shows what the file contains and where it differs from what this tool expects.');
    } else {
      lines.push(fields.typeOrdinal === null
        ? 'Agent type field not recognised, so the hero/lord filter is unavailable.'
        : `Agent type is read from string field #${fields.typeOrdinal}.`);
      lines.push(state.subtypeOrdinal === null
        ? 'No subtype field selected: pick the field holding keys such as "wh_main_emp_captain" to enable editing.'
        : `Trait pools are grouped by string field #${state.subtypeOrdinal}. Check the Subtype column looks right; change the field here if not.`);
    }
    el('summary').replaceChildren(...lines.map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }));
    el('diagnostics').textContent = diagnosticsText();
  }

  function diagnosticsText() {
    const lines = [];
    for (const seg of state.model.segments) {
      const st = seg.scanStats;
      lines.push(`[${seg.label}] ESF 0x${seg.signature.toString(16).toUpperCase()}, ${formatBytes(seg.buf.length)}, ${st.records} records, ${seg.names.length} record names, ` +
        `${seg.ascii.size} ASCII / ${seg.utf16.size} UTF-16 strings, ${st.innateStrings} innate-like keys`);
      if (!seg.names.includes(window.TwEsf.CONFIG.anchorRecord)) lines.push(`  no "${window.TwEsf.CONFIG.anchorRecord}" record name in this section`);
      if (st.partialRecords) {
        const types = [...st.unknownTypes.entries()].map(([t, n]) => `0x${t.toString(16)} ×${n}`).join(', ');
        lines.push(`  ${st.partialRecords} record(s) partly skipped because of unknown node types: ${types}`);
      }
      if (st.malformedRecords) lines.push(`  ${st.malformedRecords} record(s) skipped because their layout was not as expected`);
      if (st.incompleteCompressed) lines.push(`  ${st.incompleteCompressed} compressed block(s) without usable size/properties`);
      if (seg.trailingBytes) lines.push(`  ${seg.trailingBytes} unread byte(s) after the string tables (preserved as-is)`);
      for (const [path, n] of [...st.strayInnate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        lines.push(`  innate key outside a character record: ${n} × ${path}`);
      }
    }
    for (const problem of state.model.problems) lines.push(`PROBLEM: ${problem}`);
    const ambiguous = state.model.characters.filter((ch) => !ch.innateKey).length;
    if (ambiguous) lines.push(`${ambiguous} character(s) hold more than one innate-like key and are not editable.`);
    return lines.join('\n');
  }

  function visibleCharacters() {
    const role = el('role').value, faction = el('faction').value, location = el('location').value;
    const text = el('search').value.trim().toLowerCase();
    const onlyEditable = el('only-editable').checked;
    return state.model.characters.filter((ch) => {
      if (state.fields.typeOrdinal !== null && role !== 'all') {
        const isLord = agentType(ch) === Save.LORD_AGENT_TYPE;
        if ((role === 'heroes') === isLord) return false;
      }
      if (faction !== ALL && ch.context !== faction) return false;
      if (location !== ALL && ch.path !== location) return false;
      if (onlyEditable && options(ch).length < 2) return false;
      if (text) {
        const haystack = [ch.context, agentType(ch), subtype(ch), ch.innateKeys.join(' '), ch.texts.join(' ')].join(' ').toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  function addCell(tr, text, detail) {
    const td = document.createElement('td');
    td.textContent = text;
    if (detail) {
      const small = document.createElement('small');
      small.textContent = detail;
      td.appendChild(small);
    }
    tr.appendChild(td);
    return td;
  }

  function buildRow(ch) {
    const tr = document.createElement('tr');
    tr.title = ch.path;
    tr.classList.toggle('changed', state.edits.has(ch));
    addCell(tr, ch.context || '—');
    addCell(tr, agentType(ch) || '—');
    addCell(tr, subtype(ch) || '—');
    addCell(tr, ch.texts.join(' · ') || '—');
    if (ch.innateKey) addCell(tr, traitLabel(ch.innateKey), ch.innateKey);
    else addCell(tr, 'several keys', ch.innateKeys.join(', '));

    const td = document.createElement('td');
    const opts = options(ch);
    if (opts.length > 1) {
      const select = document.createElement('select');
      for (const { key, count } of opts) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = key === ch.innateKey ? `${traitLabel(key)} (current)` : `${traitLabel(key)} – seen on ${count}`;
        option.title = key;
        select.appendChild(option);
      }
      select.value = state.edits.get(ch) || ch.innateKey;
      select.addEventListener('change', () => {
        if (select.value === ch.innateKey) state.edits.delete(ch); else state.edits.set(ch, select.value);
        tr.classList.toggle('changed', state.edits.has(ch));
        renderPending();
      });
      td.appendChild(select);
    } else {
      td.textContent = ch.innateKey ? 'no alternative seen in this save' : 'not editable';
    }
    tr.appendChild(td);
    return tr;
  }

  function renderTable() {
    const visible = visibleCharacters();
    el('rows').replaceChildren(...visible.slice(0, MAX_ROWS).map(buildRow));
    el('table-note').textContent = visible.length > MAX_ROWS
      ? `Showing the first ${MAX_ROWS} of ${visible.length} matches – narrow the filters to see the rest.`
      : `${visible.length} match(es). Hover a row to see where the record is stored.`;
  }

  function renderPending() {
    const n = state.edits.size;
    el('pending').textContent = n ? `${n} pending change(s).` : 'No changes selected yet.';
    el('build').disabled = state.busy || n === 0;
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function buildAndDownload() {
    if (state.busy || !state.edits.size) return;
    setBusy(true);
    setStatus('export-status', '');
    try {
      const out = await Save.build(state.model, state.edits, progress);
      const problems = await Save.verify(out, state.model, state.edits, progress);
      if (problems.length) throw new Error(`the produced file did not verify (${problems.slice(0, 3).join('; ')})`);
      const name = `${state.fileName.replace(/\.save$/i, '')}_edited.save`;
      download(out, name);
      setStatus('export-status',
        `${name} (${formatBytes(out.length)}) was built and re-read successfully: ${state.edits.size} change(s) confirmed in the file. ` +
        'Whether the game accepts it is not something this page can check – load it in game before relying on it.', 'ok');
    } catch (err) {
      console.error(LOG_PREFIX, 'build failed', err);
      setStatus('export-status', `No file was produced: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  el('file').addEventListener('change', (e) => openFile(e.target.files[0]));
  const drop = el('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    openFile(e.dataTransfer.files[0]);
  });
  ['role', 'faction', 'location', 'only-editable'].forEach((id) => el(id).addEventListener('change', renderTable));
  el('search').addEventListener('input', renderTable);
  el('subtype-field').addEventListener('change', (e) => {
    // Pools depend on the grouping field, so earlier choices are no longer valid.
    state.subtypeOrdinal = e.target.value === '' ? null : Number(e.target.value);
    state.edits.clear();
    refresh();
  });
  el('build').addEventListener('click', buildAndDownload);
  el('reset').addEventListener('click', () => {
    state.edits.clear();
    renderTable();
    renderPending();
  });
})();
