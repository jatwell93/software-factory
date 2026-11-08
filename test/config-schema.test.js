"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const YAML = require("yaml");

const root = path.join(__dirname, "..");
const schema = JSON.parse(
  fs.readFileSync(
    path.join(root, "schema", "factory.config.schema.json"),
    "utf8",
  ),
);
const sample = YAML.parse(
  fs.readFileSync(
    path.join(root, "examples", "date-management-app.factory.config.yml"),
    "utf8",
  ),
);

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const problems = (config) =>
  validate(config) ? [] : validate.errors.map((e) => e.message);
const withChange = (change) => ({ ...structuredClone(sample), ...change });

test("the sample config for date-management-app validates", () => {
  assert.deepEqual(problems(sample), []);
});

test("the smallest valid config has three keys", () => {
  const minimal = {
    spec_source: "openspec",
    owner: "jatwell93",
    gates: [{ run: "npm test" }],
  };
  assert.deepEqual(problems(minimal), []);
});

for (const key of ["spec_source", "owner", "gates"]) {
  test(`a config without ${key} is refused`, () => {
    const config = structuredClone(sample);
    delete config[key];
    assert.ok(problems(config).some((m) => m.includes(key)));
  });
}

test("an unknown key is refused, so the baseline cannot be edited from config", () => {
  assert.notDeepEqual(problems(withChange({ unprotect: [".github/**"] })), []);
  assert.notDeepEqual(problems(withChange({ baseline: [] })), []);
});

const bad = [
  ["owner with a space", { owner: "not a login" }],
  ["empty gates", { gates: [] }],
  ["a gate with no run", { gates: [{ when: ["a/**"] }] }],
  ["a gate with an empty when", { gates: [{ when: [], run: "x" }] }],
  ["a zero spend cap", { spend_cap_usd: 0 }],
  ["a change id limit over 42", { change_id_max_length: 43 }],
  ["a zero review timeout", { reviews_timeout_minutes: 0 }],
  ["a spec source with capitals", { spec_source: "OpenSpec" }],
  ["a duplicate ci workflow", { ci_workflows: ["Tests", "Tests"] }],
  ["a bot with the [bot] suffix", { review_bots: ["sentry[bot]"] }],
  ["an unknown label key", { labels: { ready_label: "x" } }],
  ["a bad node version", { runner: { node_version: "latest" } }],
];
for (const [title, change] of bad) {
  test(`refuses ${title}`, () => {
    assert.notDeepEqual(problems(withChange(change)), []);
  });
}

test("accepts another spec source name without knowing the adapter", () => {
  assert.deepEqual(problems(withChange({ spec_source: "paul" })), []);
  assert.deepEqual(
    problems(withChange({ spec_source: "my-bespoke-flow" })),
    [],
  );
});

test("every optional key has a default in the schema", () => {
  const required = new Set(schema.required);
  const noDefault = Object.entries(schema.properties)
    .filter(
      ([key, def]) =>
        !required.has(key) && def.type !== "object" && !("default" in def),
    )
    .map(([key]) => key);
  assert.deepEqual(noDefault, []);
});
