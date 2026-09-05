import fs from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_PATH) {
  console.error('Refusing to run against the default database. Set DATABASE_PATH.');
  process.exit(1);
}

const { config } = await import('../src/config.js');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.db.path + suffix, { force: true });
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });

const { blog } = await import('../src/db/queries.js');
const { validate, uniqueSlug, render } = await import('../src/services/blogService.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}` +
    (ok ? '' : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
};

console.log('\n- validation -');
check('a post needs a title', validate({ title: '', body: 'x' }).ok, false);
check('a post needs a body', validate({ title: 'V1.1', body: '' }).ok, false);
const v = validate({ title: 'V1.1 - New features', body: 'We shipped **drift** detection.' });
check('a real post validates', v.ok, true);
check('a missing summary is generated', v.summary.length > 0, true);

console.log('\n- draft first, publish later -');
const slug = uniqueSlug(v.title);
check('slug derives from the title', slug, 'v1-1-new-features');
const id = Number(blog.create({
  slug, title: v.title, summary: v.summary, body: v.body, published: false, authorId: 'op',
}).lastInsertRowid);
check('created', blog.byId(id).title, 'V1.1 - New features');
check('a draft is not public', blog.listPublished(50).length, 0);
check('but it is visible to the operator', blog.listAll(100).length, 1);
check('and has no publish date yet', blog.byId(id).published_at, null);

const pub = blog.update(id, { title: v.title, summary: v.summary, body: v.body, published: true });
check('publishing makes it public', blog.listPublished(50).length, 1);
check('and stamps a date', typeof pub.published_at, 'number');
const stamped = pub.published_at;

const edited = blog.update(id, {
  title: 'V1.1 - New features', summary: v.summary, body: 'Edited body.', published: true,
});
check('editing does not reorder the archive', edited.published_at, stamped);
check('the URL survives a retitle', edited.slug, slug);

console.log('\n- slugs stay unique -');
const slug2 = uniqueSlug('V1.1 - New features');
check('a clashing title gets its own slug', slug2 === slug, false);
blog.create({ slug: slug2, title: 'V1.1 - New features', summary: 's', body: 'b', published: true, authorId: 'op' });
check('both posts exist', blog.listAll(100).length, 2);

console.log('\n- rendering is escape-first -');
const nasty = render('<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>');
check('no script tag survives', /<script/i.test(nasty), false);
check('no javascript: href survives', /javascript:/i.test(nasty), false);
const liveTags = (nasty.match(/<[a-zA-Z][^>]*>/g) ?? []).map((t) => t.toLowerCase());
check("only the renderer's own tags are live", liveTags, ["<p>"]);
check('markdown still works', /<strong>/.test(render('**bold**')), true);

console.log('\n- unpublish and delete -');
blog.update(id, { title: v.title, summary: v.summary, body: 'b', published: false });
check('unpublishing hides it again', blog.listPublished(50).length, 1);
blog.remove(id);
check('deleting removes it', blog.byId(id), undefined);

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
