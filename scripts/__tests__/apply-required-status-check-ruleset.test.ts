import { describe, expect, it } from 'vitest';

import type { RepoRuleset, RepoRulesetRule } from '../apply-required-status-check-ruleset';
import {
    buildRequiredStatusChecksParameters,
    buildRulesetPutPayload,
    planRequiredStatusCheckRules,
    REQUIRED_STATUS_CHECKS_RULE_TYPE,
} from '../apply-required-status-check-ruleset';

const BASE_RULES: RepoRulesetRule[] = [{ type: 'deletion' }, { type: 'non_fast_forward' }];

describe('buildRequiredStatusChecksParameters', () => {
    it('starts a fresh required_status_checks list with the up-to-date policy disabled', () => {
        expect(buildRequiredStatusChecksParameters(undefined, 'guards')).toStrictEqual({
            required_status_checks: [{ context: 'guards' }],
            strict_required_status_checks_policy: false,
        });
    });

    it('appends to an existing list instead of dropping already-required contexts', () => {
        const existing = {
            required_status_checks: [{ context: 'checks' }],
            strict_required_status_checks_policy: true,
        };
        expect(buildRequiredStatusChecksParameters(existing, 'guards')).toStrictEqual({
            required_status_checks: [{ context: 'checks' }, { context: 'guards' }],
            strict_required_status_checks_policy: true,
        });
    });

    it('does not duplicate a context that is already required', () => {
        const existing = {
            required_status_checks: [{ context: 'guards' }],
            strict_required_status_checks_policy: false,
        };
        expect(buildRequiredStatusChecksParameters(existing, 'guards')).toStrictEqual({
            required_status_checks: [{ context: 'guards' }],
            strict_required_status_checks_policy: false,
        });
    });
});

describe('planRequiredStatusCheckRules', () => {
    it('adds a new required_status_checks rule when the ruleset has none', () => {
        const plan = planRequiredStatusCheckRules(BASE_RULES, 'guards');
        expect(plan.changed).toBe(true);
        expect(plan.rules).toStrictEqual([
            ...BASE_RULES,
            {
                type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
                parameters: {
                    required_status_checks: [{ context: 'guards' }],
                    strict_required_status_checks_policy: false,
                },
            },
        ]);
        // The caller's array is never mutated in place.
        expect(BASE_RULES).toStrictEqual([{ type: 'deletion' }, { type: 'non_fast_forward' }]);
    });

    it('merges into an existing required_status_checks rule instead of adding a second one', () => {
        const rules: RepoRulesetRule[] = [
            ...BASE_RULES,
            {
                type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
                parameters: {
                    required_status_checks: [{ context: 'checks' }],
                    strict_required_status_checks_policy: false,
                },
            },
        ];
        const plan = planRequiredStatusCheckRules(rules, 'guards');
        expect(plan.changed).toBe(true);
        expect(plan.rules).toHaveLength(3);
        expect(
            plan.rules.filter((rule) => rule.type === REQUIRED_STATUS_CHECKS_RULE_TYPE),
        ).toHaveLength(1);
        expect(plan.rules[2]).toStrictEqual({
            type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
            parameters: {
                required_status_checks: [{ context: 'checks' }, { context: 'guards' }],
                strict_required_status_checks_policy: false,
            },
        });
    });

    it('is idempotent: re-planning an already-required context reports no change', () => {
        const rules: RepoRulesetRule[] = [
            ...BASE_RULES,
            {
                type: REQUIRED_STATUS_CHECKS_RULE_TYPE,
                parameters: {
                    required_status_checks: [{ context: 'guards' }],
                    strict_required_status_checks_policy: false,
                },
            },
        ];
        const plan = planRequiredStatusCheckRules(rules, 'guards');
        expect(plan.changed).toBe(false);
        expect(plan.rules).toStrictEqual(rules);
    });
});

describe('buildRulesetPutPayload', () => {
    it('passes through only the fields the update endpoint accepts, with the new rules', () => {
        const current: RepoRuleset = {
            bypass_actors: [],
            conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
            enforcement: 'active',
            id: 23_388_173,
            name: 'main-protection',
            rules: BASE_RULES,
            target: 'branch',
        };
        const plan = planRequiredStatusCheckRules(current.rules, 'guards');
        const payload = buildRulesetPutPayload(current, plan.rules);
        expect(payload).toStrictEqual({
            bypass_actors: [],
            conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
            enforcement: 'active',
            name: 'main-protection',
            rules: plan.rules,
            target: 'branch',
        });
        // Read-only/server-assigned fields never leak into the write payload.
        expect(payload).not.toHaveProperty('id');
    });
});
