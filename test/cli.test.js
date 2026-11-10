const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfigError } = require('../lib/config.js');
const { runCli } = require('../lib/cli.js');

function withExitCode(fn) {
  const saved = process.exitCode;
  try {
    fn();
  } finally {
    process.exitCode = saved;
  }
}

test('runCli sets the exit code a script returns', () => {
  withExitCode(() => {
    runCli(() => 3);
    assert.equal(process.exitCode, 3);
  });
});

test('runCli reports a config problem and exits 2', () => {
  withExitCode(() => {
    const messages = [];
    runCli(
      () => {
        throw new ConfigError('bad config');
      },
      (m) => messages.push(m),
    );
    assert.equal(process.exitCode, 2);
    assert.deepEqual(messages, ['bad config']);
  });
});

test('runCli reports a malformed spec file and exits 2', () => {
  withExitCode(() => {
    const messages = [];
    runCli(
      () => {
        throw Object.assign(new Error('bad no_go'), { userError: true });
      },
      (m) => messages.push(m),
    );
    assert.equal(process.exitCode, 2);
    assert.deepEqual(messages, ['bad no_go']);
  });
});

test('runCli lets any other failure through, so the job goes red', () => {
  withExitCode(() => {
    assert.throws(
      () =>
        runCli(() => {
          throw new Error('HTTP 502');
        }),
      /HTTP 502/,
    );
  });
});
