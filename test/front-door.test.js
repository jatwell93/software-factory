const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { COMMANDS, SCRIPTS_DIR, helpText, runFrontDoor } = require('../lib/front-door.js');

function capture(argv, options = {}) {
  const out = [];
  const err = [];
  const code = runFrontDoor(argv, { ...options, log: (m) => out.push(m), err: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('every command points at a script that exists', () => {
  for (const [name, { script }] of Object.entries(COMMANDS)) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, script)), `${name} -> ${script}`);
  }
});

test('help lists every command and exits 0', () => {
  const { code, out } = capture(['help']);
  assert.equal(code, 0);
  for (const name of Object.keys(COMMANDS)) assert.match(out, new RegExp(`\\b${name}\\b`));
  assert.equal(out, helpText());
});

test('no command is a usage error that prints the help', () => {
  const { code, err } = capture([]);
  assert.equal(code, 2);
  assert.match(err, /usage: factory <command>/);
});

test('an unknown command is a usage error that names it', () => {
  const { code, err } = capture(['frobnicate']);
  assert.equal(code, 2);
  assert.match(err, /unknown command "frobnicate"/);
});

test('a name inherited from Object.prototype is an unknown command, not a crash', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const { code, err } = capture([name]);
    assert.equal(code, 2, name);
    assert.match(err, /unknown command/);
  }
});

test('the script runs in the given directory and its exit code comes back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-door-'));
  try {
    // doctor refuses arguments with exit 2, which proves args and the code pass through.
    assert.equal(capture(['doctor', 'extra'], { cwd: dir }).code, 2);
    // new-change with no id is also a usage error.
    assert.equal(capture(['new-change'], { cwd: dir }).code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
