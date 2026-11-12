/* Player-faction UI. Save bytes and optional language files remain local. */
(function () {
  'use strict';
  const Save = window.TwSave, Labels = window.TwLabels;
  const el = id => document.getElementById(id);
  const state = { model: null, fileName: '', fields: null, subtypeOrdinal: null, pools: new Map(), labels: new Map(), edits: new Map(), busy: false, exporting: false, downloadUrl: null, progressStage: '' };
  const type = ch => ch.direct.get(state.fields.typeOrdinal) || '';
  const subtype = ch => ch.direct.get(state.subtypeOrdinal) || '';
  const options = ch => Save.optionsFor(ch, state.pools, state.subtypeOrdinal);
  const trait = key => Labels.trait(state.labels, key);
  function status(id, message, kind = '') { el(id).textContent = message; el(id).className = kind; }
  function clearDownload() {
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
    el('download-again').hidden = true;
    el('download-again').removeAttribute('href');
  }
  function progress(label, fraction) {
    const exporting = state.exporting;
    el(exporting ? 'export-progress' : 'progress').hidden = false;
    el(exporting ? 'export-meter' : 'load-meter').value = fraction || 0;
    el(exporting ? 'export-progress-label' : 'progress-label').textContent = `${label} ${Math.round((fraction || 0) * 100)}%`;
    if (exporting && label !== state.progressStage) {
      state.progressStage = label;
      status('export-status', label);
    }
    // Yield to rendering/input without the nested setTimeout minimum delay.
    if (window.scheduler && typeof window.scheduler.yield === 'function') return window.scheduler.yield();
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  }
  function setBusy(value) {
    state.busy = value;
    for (const id of ['file', 'language', 'subtype-field', 'role', 'search', 'inactive', 'reset']) el(id).disabled = value;
    for (const select of el('rows').querySelectorAll('select')) select.disabled = value;
    el('build').disabled = value || !state.edits.size || Boolean(state.model?.editBlockers.length);
    if (!value) el('progress').hidden = true;
  }
  async function openFile(file) {
    if (state.busy || !file) return;
    if (state.edits.size && !window.confirm('Opening another save clears your selected changes. Continue?')) return;
    clearDownload();
    setBusy(true); state.model = null; state.edits.clear();
    status('status', ''); status('export-status', '');
    for (const id of ['summary-section', 'edit-section', 'export-section', 'technical-section']) el(id).hidden = true;
    try {
      if (file.size > Save.MAX_INPUT_BYTES) throw new Error('Save exceeds the 64 MiB input limit. Use a smaller save.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      await progress('Reading your save…', 0);
      state.model = await Save.load(bytes, progress);
      state.fileName = file.name;
      state.fields = Save.detectFields(state.model.characters);
      state.subtypeOrdinal = state.fields.subtypeOrdinal;
      el('subtype-field').replaceChildren();
      for (const candidate of [{ ordinal: '', samples: ['Not detected — editing disabled'] }, ...state.fields.candidates]) {
        const option = document.createElement('option');
        option.value = candidate.ordinal;
        option.disabled = candidate.ordinal !== 13;
        option.textContent = candidate.ordinal === '' ? candidate.samples[0] : `Field ${candidate.ordinal}: ${candidate.samples.join(', ')}`;
        el('subtype-field').appendChild(option);
      }
      el('subtype-field').value = state.subtypeOrdinal === null ? '' : String(state.subtypeOrdinal);
      el('inactive').checked = false; el('search').value = ''; el('role').value = 'all';
      refresh();
      el('summary-section').hidden = false; el('technical-section').hidden = false;
      const available = Boolean(state.model.playerFaction);
      status('compatibility', state.model.editBlockers.length ? state.model.editBlockers.join(' ') : `${state.model.gameVersion}. Structural tests passed on one sample only; DLC/mod eligibility and in-game results are not guaranteed.`, state.model.editBlockers.length ? 'error' : 'note');
      el('edit-section').hidden = !available; el('export-section').hidden = !available;
      status('status', available ? `Loaded ${file.name}.` : 'The player faction could not be identified. Editing is disabled; see Technical details.', available ? 'ok' : 'error');
    } catch (err) { console.error(err); status('status', `Could not read this file: ${err.message} Select a supported .save file; keep the original unchanged.`, 'error'); }
    finally { setBusy(false); }
  }
  function refresh() {
    const model = state.model;
    state.pools = Save.buildPools(model.characters, state.subtypeOrdinal);
    el('faction-name').textContent = Labels.resolve(state.labels, 'factions_screen_name_' + model.playerFaction) || model.playerFactionLabel || model.playerFaction || 'Player faction not identified';
    const active = model.playerCharacters.filter(c => c.active).length;
    el('summary').textContent = `${active} active character(s) with innate traits. ${model.playerCharacters.length - active} additional faction records are hidden unless you include reserve / inactive records.`;
    el('diagnostics').textContent = [
      `Player faction: ${model.playerFaction || 'unknown'}`,
      `Local faction comes from CAMPAIGN_SETUP_LOCAL, with SAVE_GAME_HEADER as fallback.`,
      `Active ownership: FACTION/CHARACTER links to CHARACTER_DETAILS; internal colonel records excluded.`,
      ...model.segments.map(s => `${s.label}: 0x${s.signature.toString(16)}, ${s.scanStats.records} records; ${s.scanStats.malformedRecords} malformed; ${s.scanStats.partialRecords} partially skipped`),
      ...model.problems,
    ].join('\n');
    renderTable(); renderPending();
  }
  function visibleCharacters() {
    const role = el('role').value, query = el('search').value.trim().toLowerCase();
    return state.model.playerCharacters.filter(ch => {
      if (!el('inactive').checked && !ch.active) return false;
      if (role === 'lords' && type(ch) !== Save.LORD_AGENT_TYPE) return false;
      if (role === 'heroes' && type(ch) === Save.LORD_AGENT_TYPE) return false;
      return !query || [Labels.character(state.labels, ch), Labels.subtype(state.labels, subtype(ch)), ...ch.innateKeys.map(trait)].join(' ').toLowerCase().includes(query);
    });
  }
  function cell(row, text, detail) {
    const td = document.createElement('td'); td.textContent = text;
    if (detail) { const small = document.createElement('small'); small.textContent = detail; td.appendChild(small); }
    row.appendChild(td); return td;
  }
  function buildRow(ch) {
    const row = document.createElement('tr'); row.classList.toggle('changed', state.edits.has(ch));
    const name = cell(row, Labels.character(state.labels, ch), ch.active ? '' : 'Reserve / inactive record');
    name.title = (ch.nameParts || []).map(p => p.key || p.text).filter(Boolean).join(' · ');
    cell(row, Labels.subtype(state.labels, subtype(ch)), type(ch) === 'general' ? 'Lord' : 'Hero').title = subtype(ch);
    cell(row, ch.innateKey ? trait(ch.innateKey) : 'Multiple innate traits — editing disabled').title = ch.innateKeys.join(', ');
    const td = cell(row, ''), opts = options(ch);
    if (state.model.editBlockers.length) td.textContent = 'Read-only — see version notice';
    else if (opts.length < 2) td.textContent = 'No alternative found in this save';
    else {
      const select = document.createElement('select'); select.setAttribute('aria-label', `New trait for ${Labels.character(state.labels, ch)}`);
      for (const { key } of opts) {
        const option = document.createElement('option'); option.value = key;
        option.textContent = trait(key) + (key === ch.innateKey ? ' (current)' : ''); option.title = key;
        select.appendChild(option);
      }
      select.value = state.edits.get(ch) || ch.innateKey;
      select.addEventListener('change', () => {
        if (state.busy) return;
        clearDownload(); status('export-status', '');
        if (select.value === ch.innateKey) state.edits.delete(ch); else state.edits.set(ch, select.value);
        row.classList.toggle('changed', state.edits.has(ch)); renderPending();
      }); td.appendChild(select);
    }
    return row;
  }
  function renderTable() {
    const visible = visibleCharacters();
    el('rows').replaceChildren(...visible.slice(0, 1000).map(buildRow));
    el('table-note').textContent = visible.length ? `${visible.length} character(s)${visible.length > 1000 ? ' — showing the first 1,000; narrow your search' : ''}.` : 'No characters match. Try another filter or include reserve / inactive records.';
  }
  function renderPending() {
    el('pending').textContent = state.edits.size ? `${state.edits.size} change(s) selected, including any hidden by your current filters.` : 'No changes selected.';
    el('build').disabled = state.busy || !state.edits.size || Boolean(state.model?.editBlockers.length);
  }
  async function loadLanguage(files) {
    if (state.busy || !files.length) return;
    setBusy(true);
    try {
      const next = new Map(state.labels);
      for (const file of files) {
        await progress(`Reading ${file.name}…`, 0);
        for (const [key, value] of await Labels.readFile(file)) next.set(key, value);
      }
      state.labels = next;
      status('language-status', `${next.size.toLocaleString()} language entries loaded locally. Missing translations keep their fallback labels.`, 'ok');
      refresh();
    } catch (err) { status('language-status', `Could not load language files: ${err.message}`, 'error'); }
    finally { setBusy(false); }
  }
  async function buildAndDownload() {
    if (state.busy || !state.edits.size) return;
    state.exporting = true; state.progressStage = ''; clearDownload();
    setBusy(true); el('build').textContent = 'Preparing your save…';
    try {
      await progress('Preparing your edited copy…', 0);
      // Let the browser paint the busy state before the first CPU-heavy phase.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const [ch, key] of state.edits) {
        if (!state.model.playerCharacters.includes(ch) || !options(ch).some(o => o.key === key)) throw new Error('A selected change is not valid for your faction.');
      }
      el('build').textContent = 'Building and verifying…';
      const out = await Save.build(state.model, state.edits, progress);
      await progress('Re-reading the edited file…', 0);
      const problems = await Save.verify(out, state.model, state.edits, progress);
      if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
      const name = state.fileName.replace(/\.save$/i, '') + '_edited.save';
      await progress('Preparing download…', 1);
      const url = state.downloadUrl = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
      const a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      const retry = el('download-again'); retry.href = url; retry.download = name; retry.hidden = false;
      status('export-status', `${name} is ready. Download requested—check your browser’s downloads. If it did not start, use “Download again”.`, 'ok');
    } catch (err) { console.error(err); status('export-status', `No file was produced: ${err.message}`, 'error'); }
    finally {
      state.exporting = false; el('export-progress').hidden = true;
      el('build').textContent = 'Verify and download edited save'; setBusy(false);
    }
  }
  window.addEventListener('beforeunload', event => {
    if (state.edits.size || state.busy) { event.preventDefault(); event.returnValue = ''; }
  });
  el('file').addEventListener('change', e => openFile(e.target.files[0]));
  el('language').addEventListener('change', e => loadLanguage([...e.target.files]));
  const drop = el('drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); openFile(e.dataTransfer.files[0]); });
  for (const id of ['role', 'inactive']) el(id).addEventListener('change', renderTable);
  el('search').addEventListener('input', renderTable);
  el('subtype-field').addEventListener('change', e => { state.subtypeOrdinal = e.target.value === '' ? null : Number(e.target.value); state.edits.clear(); clearDownload(); refresh(); });
  el('build').addEventListener('click', buildAndDownload);
  el('reset').addEventListener('click', () => { state.edits.clear(); clearDownload(); status('export-status', ''); renderTable(); renderPending(); });
})();
