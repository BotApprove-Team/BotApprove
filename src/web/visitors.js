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
  const agent = ua(req);
  if (!/Claude-User|Claude-Web/i.test(agent)) return null;
  // Claude Code names itself, which is worth more than any address check:
  //   Claude-User (claude-code/2.1.270; +https://support.anthropic.com/)
  // against the app's
  //   Mozilla/5.0 ... compatible; Claude-User/1.0; +claude-user@anthropic.com
  return /claude-code/i.test(agent) ? 'code' : 'web';
}

/**
 * Who gets the memorial instead of the page.
 *
 * Training crawlers, and any assistant fetching on somebody's behalf. There is
 * no good reason to have one read out a page you could open yourself.
 *
 * This used to exempt Claude Code by checking the source address against
 * Anthropic's published ranges, on the theory that Claude Code runs from the
 * user's own machine. It was wrong twice over. The published list is a handful
 * of individual addresses that rotate, so a real Claude-User arrived from
 * 34.162.191.81, matched none of them, and was waved through as Claude Code.
 * And nobody has ever observed what Claude Code actually sends, so the exempt
 * case was a guess resting on a list that goes stale.
 *
 * So the address decides nothing here any more. It still labels the greeting
 * and the log, where being wrong costs nothing.
 */
export function servesMemorial(req) {
  if (neverObstruct(req)) return false;
  if (isTraining(req)) return true;
  // Claude Code is exempt again, this time because it says so in its user
  // agent rather than because of a guess about which addresses it uses. It runs
  // on the machine of somebody working on this site, and handing their own
  // tooling a wall of classical Chinese instead of the page they are editing
  // helps nobody.
  return isUserTriggered(req) && claudeKind(req) !== 'code';
}
