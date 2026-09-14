#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const ejs = (await import('ejs')).default;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

const VIEWS = path.resolve('src/web/views');

const ROUTE = {
  terms: '/terms',
  privacy: '/privacy',
  'rp-terms': '/raidprotector/terms',
  'rp-privacy': '/raidprotector/privacy',
};

function render(view) {
  const file = path.join(VIEWS, `${view}.ejs`);
  return ejs.render(fs.readFileSync(file, 'utf8'), {
    title: 'T',
    updated: config.legal.updated,
    operator: config.legal.operator,
    contactUrl: config.legal.contactUrl,
    inviteUrl: config.inviteUrl,
    baseUrl: config.web.baseUrl,
    path: ROUTE[view],
    indexable: true,
    csrfToken: '',
    user: null,
    isOwner: false,
    paywallEnabled: config.paywall.enabled,
    cssVersion: '1',
    supportUrl: config.supportUrl,
    repoUrl: config.repoUrl,
    flash: null,
  }, { filename: file });
}

const pages = ['terms', 'privacy', 'rp-terms', 'rp-privacy'];
const html = {};

console.log('\n- every legal page renders -');
for (const p of pages) {
  let out = null;
  try {
    out = render(p);
  } catch (err) {
    failures += 1;
    console.log(` FAIL  ${p} threw: ${err.message}`);
  }
  html[p] = (out ?? '').replace(/\s+/g, ' ');
  check(`${p} produced a page`, (out ?? '').length > 2000, true);
}

console.log('\n- nothing unfilled leaks into a legal document -');
for (const p of pages) {
  check(`${p} has no undefined`, /undefined/.test(html[p]), false);
  check(`${p} has no unrendered tag`, /<%/.test(html[p]), false);
  check(`${p} names the operator`, html[p].includes(config.legal.operator), true);
  check(`${p} carries a date`, html[p].includes(config.legal.updated), true);
}

console.log('\n- Discord needs both documents reachable and cross-linked -');
check('RaidProtector terms points at its privacy policy',
  html['rp-terms'].includes('/raidprotector/privacy'), true);
check('and the privacy policy points back',
  html['rp-privacy'].includes('/raidprotector/terms'), true);
check('the licence defers to the BotApprove terms for billing',
  html['rp-terms'].includes('href="/terms"'), true);

console.log('\n- the claims the two bots must not swap -');
check('BotApprove still says it cannot read messages',
  /does not request the Message Content intent/.test(html.privacy), true);
check('RaidProtector says plainly that it does read them',
  /holds the Message Content intent/.test(html['rp-privacy']), true);
check('and that it never writes them down',
  /never written to the database/.test(html['rp-privacy']), true);
check('it states the consequence rather than hiding it',
  /see the pattern, not a transcript/.test(html['rp-privacy']), true);
check('direct messages are ruled out',
  /Direct messages are not read/.test(html['rp-privacy']), true);

console.log('\n- a bot that acts on people has to say so -');
check('automated decisions are their own section',
  /Automated decisions/.test(html['rp-privacy']), true);
check('the beta default is stated in the terms',
  /report what it would have done/.test(html['rp-terms']), true);
check('the owner is told the actions are theirs',
  /responsible for what it does in your server/i.test(html['rp-terms']), true);
check('and that the operator cannot undo them',
  /cannot undo a moderation action in someone else/.test(html['rp-privacy']), true);

console.log('\n- Discord requires an independence statement -');
for (const p of ['terms', 'rp-terms']) {
  check(`${p} disclaims affiliation with Discord`,
    /not affiliated with, endorsed by, or operated by Discord/.test(html[p]), true);
}

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
