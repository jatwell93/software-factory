'use strict';

/**
 * The tracking issue of a change: the place the factory escalates, reports
 * completion and parks the change. It is, in order:
 *
 *   1. an open issue labelled <prefix><id>
 *   2. else the open issue the proposal names (the adapter's `issue` autonomy
 *      key), which gets the label, so a change written for an existing issue
 *      reports there
 *   3. else a new issue titled `factory: <id>`
 *
 * @param {string} id
 * @param {{config: object, adapter: object, gh: (args: string[]) => string}} ctx
 * @returns {number} The issue number.
 */
function trackingIssue(id, { config, adapter, gh }) {
  const label = `${config.labels.change_prefix}${id}`;

  function labelled() {
    const args = ['issue', 'list', '--state', 'open', '--label', label, '--json', 'number'];
    const list = JSON.parse(gh(args));
    return list.length ? list[0].number : 0;
  }

  function ensureLabel() {
    gh([
      'label',
      'create',
      label,
      '--force',
      '--color',
      '5319E7',
      '--description',
      `Factory task for ${id}`,
    ]);
  }

  /** The number the proposal names, if that issue is still open; else 0. */
  function adopt() {
    const active = adapter.listChanges().some((c) => c.id === id);
    const number = active ? adapter.readAutonomy(id).issue || 0 : 0;
    if (!number) return 0;
    const { state } = JSON.parse(gh(['issue', 'view', String(number), '--json', 'state']));
    if (state !== 'OPEN') return 0;
    ensureLabel();
    gh(['issue', 'edit', String(number), '--add-label', label]);
    return number;
  }

  function create() {
    ensureLabel();
    const url = gh([
      'issue',
      'create',
      '--title',
      `factory: ${id}`,
      '--label',
      label,
      '--body',
      `Tracking issue for the factory run of \`${id}\`.`,
    ]);
    return Number(url.trim().split('/').pop());
  }

  return labelled() || adopt() || create();
}

module.exports = { trackingIssue };
