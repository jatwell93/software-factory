'use strict';

const { FACTORY_REPO } = require('./pin.js');

const OWNER_SETUP = `https://github.com/${FACTORY_REPO}/blob/main/docs/owner-setup.md`;

/** The sections of docs/owner-setup.md that `init` and `doctor` point to, by anchor. */
const ANCHORS = {
  secret: 'the-secret',
  app: 'the-claude-github-app',
  ruleset: 'the-branch-ruleset',
  approval: 'the-approval-policy',
  factoryDir: 'factory_dir',
};

/** A link to one section of the owner setup page. */
const ownerDoc = (section) => `${OWNER_SETUP}#${ANCHORS[section]}`;

module.exports = { ANCHORS, OWNER_SETUP, ownerDoc };
