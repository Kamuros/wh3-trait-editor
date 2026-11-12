const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), path = require('node:path');
const ctx = vm.createContext({ window: {}, TextDecoder });
for (const f of ['esf', 'savefile']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', f + '.js'), 'utf8'), ctx);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const variable = n => { let a = [n & 127]; while (n >>= 7) a.unshift(128 | (n & 127)); return Buffer.from(a); };
const names = [], strings = [];
const str = text => { if (!strings.includes(text)) strings.push(text); return Buffer.concat([Buffer.from([15]), u32(strings.indexOf(text))]); };
const num = value => Buffer.concat([Buffer.from([8]), u32(value)]);
const rec = (name, fields) => { if (!names.includes(name)) names.push(name); const body = Buffer.concat(fields); return Buffer.concat([Buffer.from([0xa0]), u16(names.indexOf(name)), Buffer.from([0]), variable(body.length), body]); };
function detail(id, characterId, faction, key) {
  const fields = Array.from({ length: 31 }, () => Buffer.from([20]));
  fields[0] = rec('CHARACTER_NAME', [rec('CHARACTER_NAME_ELEMENT', [rec('CAMPAIGN_LOCALISATION', [str('names_name_' + id)]), str('forename'), str('OTHER')])]);
  fields[3] = str(faction); fields[4] = num(characterId); fields[12] = str('engineer'); fields[13] = str('wh3_main_test_hero'); fields[22] = num(id);
  fields.push(str(key)); return rec('CHARACTER_DETAILS', fields);
}
function active(faction, id, characterId) {
  return rec('FACTION', [num(0), str(faction), rec('CHARACTER_ARRAY', [rec('CHARACTER', [num(0), num(characterId), str('engineer'), num(id)])])]);
}
const root = rec('ROOT', [rec('CAMPAIGN_SETUP_LOCAL', [str('player')]),
 active('player', 10, 100), active('enemy', 20, 200),
 // Current ownership must override birthplace / previous faction.
 detail(10, 100, 'enemy', 'wh3_skill_innate_all_cunning'),
 detail(20, 200, 'player', 'wh3_skill_innate_all_strong'),
 detail(30, 0, 'player', 'wh3_skill_innate_all_strong'),
 detail(40, 999, 'player', 'wh3_skill_innate_all_strong')]);
const footer = Buffer.concat([u16(names.length), ...names.flatMap(n => [u16(n.length), Buffer.from(n)]), u32(0), u32(strings.length), ...strings.flatMap((s, i) => [u32(s.length), Buffer.from(s), u32(i)])]);
const bytes = Buffer.concat([u32(0xabcb), u32(0), u32(0), u32(16 + root.length), root, footer]);
(async () => {
 const model = await ctx.window.TwSave.load(bytes, async () => {});
 assert.equal(model.playerFaction, 'player');
 assert.deepEqual(Array.from(model.playerCharacters, c => c.detailsId), [10, 30]);
 assert.equal(model.playerCharacters[0].active, true);
 assert.equal(model.playerCharacters[1].active, false);
 assert.equal(model.playerCharacters[0].nameParts[0].key, 'names_name_10');
 assert.equal(model.characters.find(c => c.detailsId === 20).faction, 'enemy');
 const altered = bytes.slice(); altered.writeUInt32LE(0xabcd, 0);
 await assert.rejects(() => ctx.window.TwSave.load(altered, async () => {}));
 console.log('PASS: player detection, current ownership, reserves, unresolved links, and name extraction');
})().catch(e => { console.error(e); process.exitCode = 1; });
