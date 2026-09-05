import { whitelist, guildConfig } from '../db/queries.js';
import { hasFeature } from './featureService.js';

function threshold(len) {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

const CONFUSABLES = {
  0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b',
  '@': 'a', $: 's', '!': 'i', '|': 'l', '¡': 'i',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', і: 'i', ѕ: 's', ц: 'u',
};

export function normalise(name) {
  return String(name ?? '')
    .replace(/I/g, 'l')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split('')
    .map((c) => CONFUSABLES[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function check(guildId, { botId, username, knownNames }) {
  const cfg = guildConfig.get(guildId);
  if (!cfg.impersonation_check) return null;
  if (!hasFeature(guildId, 'impersonation_check')) return null;

  const candidate = normalise(username);
  if (candidate.length < 3) return null;

  const known = knownNames ?? whitelist.list(guildId)
    .filter((r) => r.bot_id !== botId && r.bot_tag)
    .map((r) => ({ botId: r.bot_id, name: r.bot_tag.replace(/#\d{4}$/, '') }));

  const matches = [];
  for (const k of known) {
    if (k.botId === botId) continue;
    const target = normalise(k.name);
    if (target.length < 3) continue;

    const d = distance(candidate, target);
    if (d === 0) {
      matches.push({ botId: k.botId, name: k.name, distance: 0, exact: true });
    } else if (d <= threshold(Math.max(candidate.length, target.length))) {
      matches.push({ botId: k.botId, name: k.name, distance: d, exact: false });
    }
  }

  if (!matches.length) return null;
  matches.sort((a, b) => a.distance - b.distance);
  return { matches: matches.slice(0, 3) };
}

export function describe(result) {
  if (!result?.matches?.length) return null;
  const worst = result.matches[0];
  if (worst.exact) {
    return `This name is visually identical to **${worst.name}**, a bot already approved here, ` +
      'but it is a different account. That is the shape of a deliberate impersonation.';
  }
  return `This name is ${worst.distance} character${worst.distance === 1 ? '' : 's'} away from ` +
    `**${worst.name}**, a bot already approved here. Confirm you are looking at the right one.`;
}
