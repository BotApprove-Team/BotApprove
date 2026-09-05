#!/usr/bin/env node
import { REST, Routes } from 'discord.js';
import { config, assertConfig } from '../src/config.js';
import { commandDefinitions } from '../src/bot/commands/index.js';

assertConfig({ requireWeb: false });

const guildId = process.argv[2];
const rest = new REST({ version: '10' }).setToken(config.discord.token);

const route = guildId
  ? Routes.applicationGuildCommands(config.discord.clientId, guildId)
  : Routes.applicationCommands(config.discord.clientId);

try {
  const result = await rest.put(route, { body: commandDefinitions });
  console.log(`Registered ${result.length} commands ${guildId ? `to guild ${guildId}` : 'globally'}:`);
  for (const c of result) console.log(`  /${c.name}`);
} catch (err) {
  const code = err.code ?? err.status;
  const hint = {
    50001: guildId
      ? `The bot is not in guild ${guildId}, or was invited without the ` +
        '`applications.commands` scope. Invite it first, then re-run this.'
      : 'The token lacks access to the application.',
    0: 'Check DISCORD_TOKEN and DISCORD_CLIENT_ID in .env.',
  }[code];

  console.error(`\nRegistration failed: ${err.rawError?.message ?? err.message} (code ${code})`);
  if (hint) console.error(hint);
  process.exitCode = 1;
}

const { db } = await import('../src/db/index.js');
db.close();
