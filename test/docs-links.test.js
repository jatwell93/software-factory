const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).map((f) => `docs/${f}`)]
  .filter((f) => f.endsWith('.md'))
  // The plan and the proof repo are working notes, not pages a reader navigates.
  .filter((f) => !/plan-seamless-factory|proof-repo/.test(f));

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');

const anchorsOf = (file) =>
  fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => slug(l.replace(/^#+ /, '')));

test('every relative link in the README and docs reaches a file and, when named, a heading', () => {
  for (const page of PAGES) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [file, anchor] = target.split('#');
      const resolved = file ? path.join(path.dirname(page), file) : page;
      assert.ok(fs.existsSync(path.join(ROOT, resolved)), `${page}: ${target} has no file`);
      if (anchor && resolved.endsWith('.md')) {
        assert.ok(anchorsOf(resolved).includes(anchor), `${page}: ${target} has no such heading`);
      }
    }
  }
});

test('the README and the quickstart both lead to the owner guide', () => {
  for (const page of ['README.md', 'docs/quickstart.md']) {
    assert.match(fs.readFileSync(path.join(ROOT, page), 'utf8'), /owner-guide\.md/);
  }
});
