#!/usr/bin/env bun

/**
 * Adds a `required_status_checks` rule for one context (the `guards` job, by default) to an existing GitHub repository
 * ruleset, instead of creating separate classic branch protection. Defaults match the `main-protection` ruleset this
 * repository already has (see `docs/adr/0011-required-merge-guards.md`): it currently only carries `deletion` and
 * `non_fast_forward` rules and an empty `bypass_actors` list, so an added required check already applies to admins with
 * no further configuration -- `bypass_actors: []` blocks everyone equally.
 *
 * Dry run by default: reads the current ruleset, prints the rule this would add (or reports that it is already
 * present), and makes no remote change. Pass `--apply` to actually update it, then re-read it back from GitHub to
 * confirm the change stuck before reporting success.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export const REQUIRED_STATUS_CHECKS_RULE_TYPE = 'required_status_checks';

// Not exported: only `isRequiredStatusCheckList` and `buildRequiredStatusChecksParameters` in this file need the
// shape of one existing check entry; the test file drives them through their public `RepoRulesetRule` parameters.
interface RequiredStatusCheck {
    context: string;
    integration_id?: number;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export interface RepoRulesetRule {
    parameters?: Record<string, unknown>;
    type: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export interface RepoRuleset {
    bypass_actors: unknown[];
    conditions: Record<string, unknown>;
    enforcement: string;
    id: number;
    name: string;
    rules: RepoRulesetRule[];
    target: string;
}

/**
 * The fields GitHub's "Update a repository ruleset" endpoint accepts. Every other field on a read ruleset (`id`,
 * `node_id`, timestamps, `source`/`source_type`, `_links`, `current_user_can_bypass`) is server-assigned or read-only,
 * so the PUT payload passes through exactly this subset unchanged apart from `rules`.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export interface RepoRulesetPutPayload {
    bypass_actors: unknown[];
    conditions: Record<string, unknown>;
    enforcement: string;
    name: string;
    rules: RepoRulesetRule[];
    target: string;
}

function isRequiredStatusCheckList(value: unknown): value is RequiredStatusCheck[] {
    return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === 'object' && entry !== null && 'context' in entry)
    );
}

/**
 * Builds the `required_status_checks` rule parameters, preserving every existing pinned check and the existing
 * up-to-date policy. `strict_required_status_checks_policy: false` (require the check to pass, not that the branch also
 * be up to date first) matches this repository's existing assumption -- see the `pull-request` skill's step 3 -- that
 * sibling PRs may advance `main` without forcing every open PR to rebase.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export function buildRequiredStatusChecksParameters(
    existing: Record<string, unknown> | undefined,
    context: string,
): Record<string, unknown> {
    const existingChecks = isRequiredStatusCheckList(existing?.required_status_checks)
        ? existing.required_status_checks
        : [];
    const checks = existingChecks.some((check) => check.context === context)
        ? existingChecks
        : [...existingChecks, { context }];
    return {
        strict_required_status_checks_policy:
            typeof existing?.strict_required_status_checks_policy === 'boolean'
                ? existing.strict_required_status_checks_policy
                : false,
        required_status_checks: checks,
    };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export interface RulesetUpdatePlan {
    changed: boolean;
    rules: RepoRulesetRule[];
}

/**
 * Computes the new `rules` array for a ruleset that should require `context`, merging into an existing
 * `required_status_checks` rule (GitHub allows only one rule of that type per ruleset) instead of appending a second,
 * conflicting one. Idempotent: re-running with a context already present returns `changed: false` and the original
 * array, so a repeated `--apply` is a safe no-op.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export function planRequiredStatusCheckRules(
    rules: readonly RepoRulesetRule[],
    context: string,
): RulesetUpdatePlan {
    const existingIndex = rules.findIndex((rule) => rule.type === REQUIRED_STATUS_CHECKS_RULE_TYPE);
    if (existingIndex === -1) {
        return {
            changed: true,
            rules: [
                ...rules,
                {
                    type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
                    parameters: buildRequiredStatusChecksParameters(undefined, context),
                },
            ],
        };
    }

    const existingRule = rules[existingIndex];
    const existingChecks = isRequiredStatusCheckList(
        existingRule.parameters?.required_status_checks,
    )
        ? existingRule.parameters.required_status_checks
        : [];
    if (existingChecks.some((check) => check.context === context)) {
        return { changed: false, rules: [...rules] };
    }

    const rules_ = [...rules];
    rules_[existingIndex] = {
        type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
        parameters: buildRequiredStatusChecksParameters(existingRule.parameters, context),
    };
    return { changed: true, rules: rules_ };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/apply-required-status-check-ruleset.test.ts
export function buildRulesetPutPayload(
    current: RepoRuleset,
    rules: RepoRulesetRule[],
): RepoRulesetPutPayload {
    return {
        bypass_actors: current.bypass_actors,
        conditions: current.conditions,
        enforcement: current.enforcement,
        name: current.name,
        rules,
        target: current.target,
    };
}

async function ghApiJson<T>(arguments_: readonly string[]): Promise<T> {
    const { stdout } = await execFileAsync('gh', arguments_, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
}

async function readRuleset(owner: string, repo: string, rulesetId: number): Promise<RepoRuleset> {
    return ghApiJson<RepoRuleset>(['api', `repos/${owner}/${repo}/rulesets/${rulesetId}`]);
}

/**
 * PUTs the payload through a temp file instead of stdin: `execFile`'s promisified form has no `input` option, and a
 * temp file avoids the shell-quoting hazard of embedding this JSON directly in an argv string.
 */
async function writeRuleset(
    owner: string,
    repo: string,
    rulesetId: number,
    payload: RepoRulesetPutPayload,
): Promise<RepoRuleset> {
    const scratchDirectory = await mkdtemp(join(tmpdir(), 'caxri-ruleset-'));
    try {
        const payloadPath = join(scratchDirectory, 'ruleset.json');
        await writeFile(payloadPath, JSON.stringify(payload));
        return await ghApiJson<RepoRuleset>([
            'api',
            '--method',
            'PUT',
            `repos/${owner}/${repo}/rulesets/${rulesetId}`,
            '--input',
            payloadPath,
        ]);
    } finally {
        await rm(scratchDirectory, { force: true, recursive: true });
    }
}

interface CliOptions {
    apply: boolean;
    context: string;
    owner: string;
    repo: string;
    rulesetId: number;
}

/**
 * Applies the flag at `argv[index]` to `options` and returns the index of the next unconsumed argument. Kept as its own
 * function (not a `switch` inlined in `parseArguments`'s loop) so each case's early `return` never reads as a `break`
 * nested inside that loop.
 */
function applyArgument(options: CliOptions, argv: readonly string[], index: number): number {
    const flag = argv[index];
    switch (flag) {
        case '--apply': {
            options.apply = true;
            return index + 1;
        }
        case '--context': {
            options.context = argv[index + 1] ?? options.context;
            return index + 2;
        }
        case '--owner': {
            options.owner = argv[index + 1] ?? options.owner;
            return index + 2;
        }
        case '--repo': {
            options.repo = argv[index + 1] ?? options.repo;
            return index + 2;
        }
        case '--ruleset-id': {
            options.rulesetId = Number(argv[index + 1] ?? options.rulesetId);
            return index + 2;
        }
        default: {
            throw new Error(`Unknown argument: ${flag}`);
        }
    }
}

function parseArguments(argv: readonly string[]): CliOptions {
    const options: CliOptions = {
        apply: false,
        context: 'guards',
        owner: 'tjx666',
        repo: 'caxri',
        // The `main-protection` ruleset this repository already runs; see
        // docs/adr/0011-required-merge-guards.md.
        rulesetId: 23_388_173,
    };
    let index = 0;
    while (index < argv.length) index = applyArgument(options, argv, index);
    return options;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const current = await readRuleset(options.owner, options.repo, options.rulesetId);
    const plan = planRequiredStatusCheckRules(current.rules, options.context);

    if (!plan.changed) {
        console.log(
            `Ruleset ${options.rulesetId} (${current.name}) already requires status check ` +
                `"${options.context}"; no change needed.`,
        );
        return;
    }

    const payload = buildRulesetPutPayload(current, plan.rules);
    console.log(
        `Planned rules for ruleset ${options.rulesetId} (${current.name}):\n${JSON.stringify(
            payload.rules,
            null,
            2,
        )}`,
    );

    if (!options.apply) {
        console.log('Dry run only. Re-run with --apply to update the ruleset on GitHub.');
        return;
    }

    await writeRuleset(options.owner, options.repo, options.rulesetId, payload);
    const readBack = await readRuleset(options.owner, options.repo, options.rulesetId);
    const verification = planRequiredStatusCheckRules(readBack.rules, options.context);
    if (verification.changed) {
        console.error(
            `Read-back verification failed: ruleset ${options.rulesetId} does not report ` +
                `"${options.context}" as required after the update.`,
        );
        process.exitCode = 1;
        return;
    }

    console.log(
        `Applied. Ruleset ${options.rulesetId} (${readBack.name}) now requires status check ` +
            `"${options.context}":\n${JSON.stringify(readBack.rules, null, 2)}`,
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
