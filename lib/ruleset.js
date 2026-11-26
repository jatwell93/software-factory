'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ghReason, isNoSuchRef } = require('./gh-error.js');

const RULESET_NAME = 'software-factory';
const REQUIRED_CHECKS = ['factory/no-go-guard', 'factory/change-ids'];
// The callers that post those two checks. They run from the default branch, so until they
// are on it a required check can never report and every pull request would be stuck.
const CHECK_CALLERS = ['no-go-guard.yml', 'check-change-ids.yml'];

/** The ruleset body: deletions and force pushes blocked, the factory's checks and the project's own required. */
function rulesetBody(ciChecks, existing = null) {
  const ours = ['deletion', 'non_fast_forward', 'required_status_checks'];
  const old = (existing?.rules || []).find((r) => r.type === 'required_status_checks');
  const kept = (old?.parameters?.required_status_checks || []).map((c) => c.context);
  const contexts = [...new Set([...REQUIRED_CHECKS, ...kept, ...ciChecks])];
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    // An update keeps what the owner added by hand: bypass actors, other rules, more checks.
    bypass_actors: existing?.bypass_actors || [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: {
          ...(old?.parameters || {}),
          strict_required_status_checks_policy:
            old?.parameters?.strict_required_status_checks_policy ?? false,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
      ...(existing?.rules || []).filter((r) => !ours.includes(r.type)),
    ],
  };
}

/** What the branch's rules already require, from the rules endpoint. */
function currentRules(rules) {
  const contexts = rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
  return { contexts, noForcePush: rules.some((r) => r.type === 'non_fast_forward') };
}

/** gh api with a JSON body: the body goes through a temp file, as gh reads it from --input. */
function send(gh, method, endpoint, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ruleset-'));
  const file = path.join(dir, 'body.json');
  try {
    fs.writeFileSync(file, JSON.stringify(body));
    return gh(['api', '--method', method, endpoint, '--input', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes the default branch refuse unchecked changes: one active ruleset that requires the
 * factory's two checks and the project's own, and blocks force pushes and deletion.
 *
 * GitHub's web picker only offers a check that has already run, but the API takes the
 * name as it is, so no throwaway pull request is needed. What is needed is the check
 * callers on the default branch: required before they can run, a check never reports and
 * the pull request that adds them could not merge.
 *
 * It changes nothing when the branch already requires all of them and blocks force
 * pushes, and it updates its own ruleset in place rather than adding another.
 *
 * @returns {{status: 'created'|'updated'|'unchanged'|'skipped', note?: string}}
 */
function applyRuleset(config, ciChecks, gh) {
  const branch = config.default_branch;
  try {
    const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    for (const file of CHECK_CALLERS) {
      try {
        gh([
          'api',
          `repos/${repo}/contents/.github/workflows/${file}?ref=${branch}`,
          '--jq',
          '.sha',
        ]);
      } catch (error) {
        if (!isNoSuchRef(error)) throw error;
        return {
          status: 'skipped',
          note: `${file} is not on ${branch} yet: merge the init pull request, then run init --apply-ruleset again`,
        };
      }
    }
    const have = currentRules(JSON.parse(gh(['api', `repos/${repo}/rules/branches/${branch}`])));
    const wanted = [...REQUIRED_CHECKS, ...ciChecks];
    if (wanted.every((c) => have.contexts.includes(c)) && have.noForcePush) {
      return { status: 'unchanged' };
    }
    // The repository's own rulesets only: the default list also holds organisation rulesets,
    // and one of those with our name would be the wrong thing to PUT to this endpoint.
    const mine = JSON.parse(gh(['api', `repos/${repo}/rulesets?includes_parents=false`])).find(
      (set) => set.name === RULESET_NAME && (!set.source_type || set.source_type === 'Repository'),
    );
    if (mine) {
      const existing = JSON.parse(gh(['api', `repos/${repo}/rulesets/${mine.id}`]));
      send(gh, 'PUT', `repos/${repo}/rulesets/${mine.id}`, rulesetBody(ciChecks, existing));
      return { status: 'updated' };
    }
    send(gh, 'POST', `repos/${repo}/rulesets`, rulesetBody(ciChecks));
    return { status: 'created' };
  } catch (error) {
    return {
      status: 'skipped',
      note: `GitHub refused (${ghReason(error)}): you need admin rights on the repository; or add the ruleset by hand`,
    };
  }
}

module.exports = { RULESET_NAME, applyRuleset, rulesetBody };
