"use strict";

/**
 * An in-memory adapter that meets the contract. It is the reference for what
 * the shared suite expects, and the test double the factory's own tests can use.
 */

const { FIXTURE } = require("../adapters/contract-suite.js");

function createStubAdapter() {
  const changes = new Map();
  changes.set(FIXTURE.changeId, {
    tasks: FIXTURE.tasks.map((task) => ({ ...task, title: `Task ${task.id}` })),
    autonomy: { ...FIXTURE.autonomy, noGo: [...FIXTURE.autonomy.noGo] },
  });
  let isSetUp = false;

  const need = (changeId) => {
    const change = changes.get(changeId);
    if (!change) throw new Error(`no active change ${changeId}`);
    return change;
  };

  return {
    name: "stub",
    listChanges: () => [...changes.keys()].map((id) => ({ id })),
    listTasks: (changeId) => need(changeId).tasks.map((task) => ({ ...task })),
    readAutonomy: (changeId) => ({ ...need(changeId).autonomy }),
    tickTask(changeId, taskId) {
      const task = need(changeId).tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`no task ${taskId} in ${changeId}`);
      task.done = true;
    },
    archive(changeId) {
      need(changeId);
      changes.delete(changeId);
    },
    scaffold(changeId) {
      if (changes.has(changeId)) throw new Error(`change ${changeId} exists`);
      changes.set(changeId, {
        tasks: [],
        autonomy: { merge: "human", pr: "per-task", noGo: [] },
      });
      return { path: `changes/${changeId}` };
    },
    setup() {
      const changed = !isSetUp;
      isSetUp = true;
      return { changed };
    },
  };
}

module.exports = { createStubAdapter };
