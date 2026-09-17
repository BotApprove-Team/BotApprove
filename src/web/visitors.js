/**
 * Telling apart the things that call themselves AI.
 *
 * Three families, and they want three different answers:
 *
 *   User triggered   Claude-User, ChatGPT-User, Perplexity-User. Somebody asked
 *                    their assistant to open this page. There is a person on
 *                    the other end, so this one gets the greeting.
 *
 *   Search           Googlebot, Bingbot, Discordbot, OAI-SearchBot,
 *                    Claude-SearchBot, PerplexityBot. How the site is found and
 *                    how a shared link draws a preview. Never obstructed.
 *
 *   Training         ClaudeBot, GPTBot, CCBot and the rest. Bulk collection for
 *                    model training, which is the part worth declining.
 *
 * Google-Extended and Applebot-Extended are deliberately absent from the user
 * agent lists. They are robots.txt tokens rather than crawlers: no request ever
 * arrives with those names, the fetching is done by Googlebot and Applebot, and
 * matching on them here would mean serving a search engine the wrong thing.
 */
import { config } from '../config.js';

const USER_TRIGGERED = /Claude-User|Claude-Web|ChatGPT-User|Perplexity-User/i;

const NEVER_OBSTRUCT = new RegExp([
  'Googlebot', 'Google-InspectionTool', 'Storebot-Google', 'AdsBot-Google',
  'Bingbot', 'BingPreview', 'DuckDuckBot', 'Applebot', 'Baiduspider', 'YandexBot',
  'Discordbot', 'Twitterbot', 'facebookexternalhit', 'Slackbot', 'TelegramBot',
  'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot',
].join('|'), 'i');

const TRAINING = new RegExp([
  'ClaudeBot', 'anthropic-ai', 'GPTBot', 'CCBot', 'Bytespider', 'Diffbot',
  'meta-externalagent', 'FacebookBot', 'cohere-ai', 'Omgilibot', 'Timpibot',
  'PanguBot', 'ImagesiftBot', 'Amazonbot', 'Applebot-Extended', 'YouBot',
].join('|'), 'i');

const ua = (req) => req.get('user-agent') || '';

export const isUserTriggered = (req) => USER_TRIGGERED.test(ua(req));
export const neverObstruct = (req) => NEVER_OBSTRUCT.test(ua(req));

// Never obstruct wins. Applebot-Extended appears in both lists on purpose: the
// token is for robots.txt, and if something ever does send it as a user agent
// the search side of Applebot must not be caught by mistake.
export const isTraining = (req) => TRAINING.test(ua(req)) && !neverObstruct(req);

/**
 * Is this address one of Anthropic's?
 *
 * All their bots share the same published egress ranges, so this is what
 * separates the two things that both send Claude-User: the web app fetching a
 * page server side from Anthropic's own addresses, and Claude Code doing it
 * from the machine of whoever is sitting there.
 *
 * Only ever used to pick which greeting to show, so a range going stale costs
 * a wrong label on a joke and nothing else.
 */
function inCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (range.includes(':') !== ip.includes(':')) return false;

  if (!ip.includes(':')) {
    const toInt = (v) => v.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(ip) & mask) === (toInt(range) & mask);
  }

  // Enough for a /48 style prefix, which is all that is published.
  const head = range.split('::')[0].toLowerCase();
  return ip.toLowerCase().startsWith(head);
}

export function fromAnthropic(req) {
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  return config.anthropicRanges.some((cidr) => {
    try { return inCidr(ip, cidr); } catch { return false; }
  });
}

/**
 * 'code' when Claude Code fetched it from somebody's own machine, 'web' when
 * the Claude app fetched it from Anthropic's, null for everyone else.
 */
export function claudeKind(req) {
  if (!/Claude-User|Claude-Web/i.test(ua(req))) return null;
  return fromAnthropic(req) ? 'web' : 'code';
}
