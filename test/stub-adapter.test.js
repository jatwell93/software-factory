"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { defineContractTests } = require("../adapters/contract-suite.js");
const {
  assertAdapter,
  missingOperations,
  OPERATIONS,
} = require("../adapters/contract.js");
const { createStubAdapter } = require("./stub-adapter.js");

defineContractTests("stub", () => ({
  adapter: createStubAdapter(),
  projectRoot: ".",
}));

test("assertAdapter names every missing operation", () => {
  const partial = { name: "partial", listChanges() {}, listTasks() {} };
  assert.deepEqual(missingOperations(partial), OPERATIONS.slice(2));
  assert.throws(
    () => assertAdapter(partial),
    /partial lacks: readAutonomy, tickTask/,
  );
});

test("assertAdapter rejects a missing or invalid name", () => {
  assert.throws(() => assertAdapter({}), /needs a name/);
  assert.throws(() => assertAdapter({ name: "Bad Name" }), /needs a name/);
  assert.throws(() => assertAdapter(null), /needs a name/);
});
