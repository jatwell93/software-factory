const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectStack } = require('../lib/detect.js');

const PROJECT = '[project]\nname = "x"\n';

function gates({ pyproject = PROJECT, requirements = '' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-names-'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), pyproject);
  if (requirements) fs.writeFileSync(path.join(root, 'requirements.txt'), requirements);
  return detectStack(root).gates.map((g) => g.run);
}

test('a package that only starts with a tool name is not the tool', () => {
  for (const requirements of [
    'mypy-extensions==1.0\n',
    'mypy_extensions==1.0\n',
    'mypy.extensions\n',
    'ruff-lsp==0.0.5\n',
    'ruff_lsp\n',
    'pytest-cov==5\n',
    'pytest_asyncio\n',
    'mypy2\n',
    'ruff0\n',
    'pytest9==1\n',
  ]) {
    assert.deepEqual(gates({ requirements }), [], requirements);
  }
});

test('a quoted dependency in pyproject.toml is matched by the whole name', () => {
  const dependencies = (list) =>
    `[project]\nname = "x"\ndependencies = [${list.map((n) => `"${n}"`).join(', ')}]\n`;
  assert.deepEqual(gates({ pyproject: dependencies(['mypy-extensions>=1', 'ruff-lsp']) }), []);
  assert.deepEqual(gates({ pyproject: dependencies(['mypy>=1.0', 'ruff', 'pytest[extra]>=8']) }), [
    'ruff check .',
    'mypy .',
    'pytest',
  ]);
  assert.deepEqual(gates({ pyproject: "[project]\nname = 'x'\ndev = ['ruff==0.4']\n" }), [
    'ruff check .',
  ]);
  assert.deepEqual(gates({ pyproject: dependencies(['MyPy>=1', 'PyTest']) }), ['mypy .', 'pytest']);
});

test('a requirement line names the tool with a specifier, extras, a marker or any case', () => {
  assert.deepEqual(gates({ requirements: 'mypy[reports]>=1\n' }), ['mypy .']);
  assert.deepEqual(gates({ requirements: 'ruff==0.4\n' }), ['ruff check .']);
  assert.deepEqual(gates({ requirements: 'pytest ; python_version > "3.8"\n' }), ['pytest']);
  assert.deepEqual(gates({ requirements: 'Pytest==8\n' }), ['pytest']);
  assert.deepEqual(gates({ requirements: '  ruff\n' }), ['ruff check .']);
  assert.deepEqual(gates({ requirements: 'fastapi\nruff\nmypy\npytest\n' }), [
    'ruff check .',
    'mypy .',
    'pytest',
  ]);
});

test('a comment does not name a tool', () => {
  assert.deepEqual(gates({ requirements: '# mypy is not used here\nfastapi\n' }), []);
});

test('a [tool.<name>] table configures the tool, including its sub-tables', () => {
  assert.deepEqual(gates({ pyproject: '[tool.mypy]\nstrict = true\n' }), ['mypy .']);
  assert.deepEqual(gates({ pyproject: '[tool.ruff.lint]\nselect = ["E"]\n' }), ['ruff check .']);
  assert.deepEqual(gates({ pyproject: '[tool.pytest.ini_options]\n' }), ['pytest']);
  assert.deepEqual(gates({ pyproject: '[tool.mypyfoo]\nx = 1\n' }), []);
  assert.deepEqual(gates({ pyproject: '[tool.rufffoo]\n' }), []);
});

test('the real package next to a look-alike still counts', () => {
  assert.deepEqual(
    gates({ pyproject: '[tool.mypy]\nstrict = true\n', requirements: 'mypy-extensions\n' }),
    ['mypy .'],
  );
  assert.deepEqual(gates({ requirements: 'mypy-extensions\nmypy==1.10\n' }), ['mypy .']);
});
