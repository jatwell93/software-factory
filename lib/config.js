'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const YAML = require('yaml');
const schema = require('../schema/factory.config.schema.json');

const CONFIG_FILE = 'factory.config.yml';
const validate = new Ajv2020({
  strict: true,
  allErrors: true,
  useDefaults: true,
}).compile(schema);

class ConfigError extends Error {}

/**
 * The project's config with every default applied. Throws ConfigError when the
 * file is missing, is not YAML, or does not match the schema: a half-read config
 * would drop protections, so callers must fail on it.
 */
function loadConfig(root, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = readFile(file);
  } catch {
    throw new ConfigError(`cannot read ${CONFIG_FILE} in ${root}`);
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid YAML: ${err.message}`);
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    // Ajv fills a nested default only when its parent object exists.
    for (const key of ['runner', 'labels', 'hooks']) doc[key] ??= {};
  }
  if (!validate(doc)) {
    const why = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new ConfigError(`${CONFIG_FILE}: ${why}`);
  }
  return doc;
}

/** The longest change id this project accepts, within GitHub's 50-character label cap. */
function maxIdLength(config) {
  return Math.min(config.change_id_max_length, 50 - config.labels.change_prefix.length);
}

module.exports = { CONFIG_FILE, ConfigError, loadConfig, maxIdLength };
