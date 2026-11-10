const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');
const { taskTicket, main } = require('../scripts/factory-ticket.js');
const { tempRoot } = require('./helpers.js');

const TASKS = [
  '## 1. Work',
  '',
  '- [x] 1.1 Add the column (#812): migrate, then backfill.',
  '- [ ] 1.2 Follow up (#734) after #735 (#813): show it (#900):',
  '  - [ ] 1.3 a sub-item (#814):',
  '- [ ] 1.3 No ticket, see (#735)',
  '- [ ] 1.10 Tenth (#815): done',
].join('\n');

const root = tempRoot({ 'add-x': '# Add x\n' });
fs.writeFileSync(path.join(root, 'openspec/changes/add-x/tasks.md'), TASKS);
const config = loadConfig(root);
const adapter = loadAdapter(config, { root });

test('taskTicket reads the first (#n): on the task line, ticked or not', () => {
  assert.equal(taskTicket(adapter, 'add-x', '1.1'), 812);
  assert.equal(
    taskTicket(adapter, 'add-x', '1.2'),
    813,
    '(#734) and #735 in the title are references',
  );
  assert.equal(taskTicket(adapter, 'add-x', '1.10'), 815);
});

test('taskTicket returns 0 for a task without a ticket, a sub-item or a missing task', () => {
  assert.equal(taskTicket(adapter, 'add-x', '1.3'), 0, 'the indented 1.3 is a sub-item');
  assert.equal(taskTicket(adapter, 'add-x', '1'), 0);
  assert.equal(taskTicket(adapter, 'add-x', '9.9'), 0);
  assert.equal(taskTicket(adapter, 'gone', '1.1'), 0, 'an archived change has no ticket to close');
});

test('main prints Closes #n, or nothing, and rejects bad arguments', () => {
  const lines = [];
  const errors = [];
  const io = { config, adapter, out: (l) => lines.push(l), error: (l) => errors.push(l) };
  assert.equal(main(['add-x', '1.2'], io), 0);
  assert.equal(main(['add-x', '1.3'], io), 0);
  assert.deepEqual(lines, ['Closes #813']);
  assert.equal(main(['add-x', '../x'], io), 2);
  assert.equal(main(['', '1.1'], io), 2);
  assert.equal(errors.length, 2);
  assert.deepEqual(lines, ['Closes #813']);
});
