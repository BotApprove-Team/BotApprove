#!/usr/bin/env node
/**
 * Tell every server that the Terms and Privacy Policy changed.
 *
 *   node scripts/announce-legal.js                 who would get it, and what it says
 *   node scripts/announce-legal.js --to <guildId>  one copy, to look at it in Discord
 *   node scripts/announce-legal.js --send          the real thing, once
 *
 * Nothing is delivered without --send or --to. This goes to real people, so it
 * is run by hand rather than by a sweep, and the real run refuses to repeat.
 */
import { config } from '../src/config.js';
import { createClient } from '../src/bot/client.js';
import { setClient } from '../src/bot/clientRef.js';
import { announce, buildEmbed, alreadySent, version } from '../src/services/legalNotice.js';

const send = process.argv.includes('--send');
const toIndex = process.argv.indexOf('--to');
const onlyGuild = toIndex > -1 ? process.argv[toIndex + 1] : null;

if (toIndex > -1 && !/^\d{5,25}$/.test(String(onlyGuild))) {
  console.error('--to needs a guild id');
  process.exit(1);
}

const show = (embed) => {
  const data = embed.toJSON();
  console.log(`\n  ${data.title}\n`);
  console.log(`  ${data.description.replace(/\*\*/g, '')}\n`);
  for (const f of data.fields ?? []) {
    console.log(`  ${f.name}`);
    console.log(`    ${f.value.replace(/\*\*/g, '').split('\n').join('\n    ')}\n`);
  }
  console.log(`  ${data.footer.text}\n`);
};

const client = createClient();

client.once('clientReady', async (c) => {
  setClient(c);
  try {
    if (alreadySent()) console.log(`version ${version()} has already been announced`);

    const result = await announce(c, { send: send || Boolean(onlyGuild), onlyGuild });

    if (result.dryRun) {
      console.log(`\nnotice version ${result.version}, last sent ${result.sentVersion || "none"}`);
      console.log(`\nwould send to all ${result.would.length} server(s):`);
      for (const g of result.would) console.log(`  ${g.id}  ${g.name}`);
      console.log('\n--- what they would see ---');
      show(buildEmbed());
      console.log('nothing was sent. --to <guildId> for one copy, --send for the real run.');
    } else if (!result.ok) {
      console.error(`refused: ${result.reason}${result.at ? ` at ${result.at}` : ''}`);
      process.exitCode = 1;
    } else {
      console.log(`sent to ${result.sent} (${result.inChannel} in channel, ${result.byDm} by DM), ${result.failed} failed`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.destroy();
  }
});

await client.login(config.discord.token);
