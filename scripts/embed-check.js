import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EmbedBuilder } = require('discord.js');

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { featureState } = await import('../src/services/featureService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const GUILD = '111111111111111111';
const FIELD_LIMIT = 1024;

const { listFields } = await import('../src/bot/commands/index.js');

const states = featureState(GUILD);
const line = (f) => `${f.enabled ? 'on ' : 'off'} **${f.name}** ${f.blurb}`;

console.log('\n- the premium list really is over the raw limit -');
const raw = states.filter((f) => f.tier === 'premium').map(line).join('\n');
check('unsplit, it would be rejected', raw.length > FIELD_LIMIT, true);

console.log('\n- split into valid fields -');
const free = listFields('Free forever', states.filter((f) => f.tier === 'free').map(line));
const premium = listFields('Premium', states.filter((f) => f.tier === 'premium').map(line));
check('free fits in one field', free.length, 1);
check('premium splits into two', premium.length, 2);
check('every field is within the cap',
  [...free, ...premium].every((f) => f.value.length <= FIELD_LIMIT), true);
check('no field is empty', [...free, ...premium].every((f) => f.value.length > 0), true);
check('the continuation is labelled', premium[1].name, 'Premium (continued)');
check('no feature was dropped',
  [...free, ...premium].map((f) => f.value.split('\n').length).reduce((a, b) => a + b, 0),
  states.length);

console.log('\n- discord.js accepts the real embed -');
let built = null;
try {
  built = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('BotApprove features')
    .addFields(...free, ...premium)
    .setFooter({ text: 'Basic guarding never switches off, paid or not.' })
    .toJSON();
} catch (err) {
  built = { error: err.message };
}
check('the builder validates it', !built.error, true);
check('field count is within the 25 field cap', built.fields.length <= 25, true);

console.log('\n- and the /status premium list -');
const adds = listFields('Premium adds',
  states.filter((f) => f.tier === 'premium').map((f) => `• ${f.name}`));
let statusOk = true;
try {
  new EmbedBuilder().setTitle('x').addFields(...adds).toJSON();
} catch { statusOk = false; }
check('it validates too', statusOk, true);
check('and still fits one field', adds.length, 1);

console.log('\n- headroom for growth -');
const doubled = listFields('Premium', [...states, ...states].filter((f) => f.tier === 'premium').map(line));
check('twice as many features still splits cleanly',
  doubled.every((f) => f.value.length <= FIELD_LIMIT), true);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
