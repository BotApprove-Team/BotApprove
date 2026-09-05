import { blog } from '../db/queries.js';

export const MAX_TITLE = 140;
export const MAX_SUMMARY = 300;
export const MAX_BODY = 40_000;

export function slugify(title) {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'post';
}

export function uniqueSlug(title, ignoreId = null) {
  const base = slugify(title);
  let slug = base;
  let n = 1;
  while (true) {
    const existing = blog.bySlug(slug);
    if (!existing || existing.id === ignoreId) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function safeHref(url) {
  const u = String(url).trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null;
}

function inline(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `CODE${codes.length - 1}`;
  });

  out = out.replace(/\[([^\]]{1,120})\]\(([^)\s]{1,300})\)/g, (m, label, url) => {
    const href = safeHref(url);
    if (!href) return label;
    return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  return out.replace(/CODE(\d+)/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

export function render(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushPara(); flushList();
      out.push('<hr>');
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export function autoSummary(body) {
  const line = String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^#{2,4}\s/.test(l) && !/^---+$/.test(l));
  if (!line) return null;
  const plain = line.replace(/[*`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return plain.length > 180 ? `${plain.slice(0, 177)}...` : plain;
}

export function validate({ title, summary, body }) {
  const t = String(title ?? '').trim();
  const b = String(body ?? '').trim();
  if (t.length < 2) return { ok: false, reason: 'A title is required.' };
  if (t.length > MAX_TITLE) return { ok: false, reason: `Title must be under ${MAX_TITLE} characters.` };
  if (b.length < 2) return { ok: false, reason: 'The post body is empty.' };
  if (b.length > MAX_BODY) return { ok: false, reason: `Body must be under ${MAX_BODY} characters.` };
  const s = String(summary ?? '').trim();
  if (s.length > MAX_SUMMARY) return { ok: false, reason: `Summary must be under ${MAX_SUMMARY} characters.` };
  return { ok: true, title: t, body: b, summary: s || autoSummary(b) };
}
