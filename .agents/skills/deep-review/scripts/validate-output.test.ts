import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { extractJsonPayload, validateOutput } from './validate-output';

const validReviewIssue = {
    core_problem: 'Because the reply is not keyed, a late result can replace current state.',
    dimension: 'state-lifecycle',
    fix_cost: 'low',
    fix_options: ['Key the completion to Session identity'],
    id: 'life-1',
    issue_type: 'stale session write',
    likelihood: 'medium',
    location: 'src/renderer/src/features/editor/useDocument.ts:87',
    nature: 'introduced',
    need_test: true,
    scenario: 'Switch Sessions while a document read is pending.',
    severity: 'p1',
    summary: 'A late read can replace state for the newly selected Session.',
} as const;

describe('extractJsonPayload', () => {
    it('extracts one fenced JSON object', () => {
        expect(extractJsonPayload('Result:\n```json\n{"issues":[]}\n```\nDone')).toBe(
            '{"issues":[]}',
        );
    });

    it('accepts unfenced JSON', () => {
        expect(extractJsonPayload('  {"issues":[]}  ')).toBe('{"issues":[]}');
    });

    it('rejects missing or duplicate fence endings', () => {
        expect(() => extractJsonPayload('```json\n{"issues":[]}')).toThrow(
            'JSON fence is not closed',
        );
        expect(() =>
            extractJsonPayload('```json\n{"issues":[]}\n```\n```json\n{"issues":[]}\n```'),
        ).toThrow('Multiple JSON fences found');
    });
});

describe('validateOutput', () => {
    it('accepts a complete review payload with a release check', () => {
        expect(() =>
            validateOutput('review', {
                issues: [validReviewIssue],
                release_checks: [
                    {
                        blocks_release: true,
                        item: 'Probe native modules in the packaged Runtime',
                        why: 'Host Node does not prove Electron ABI compatibility',
                    },
                ],
            }),
        ).not.toThrow();
    });

    it('rejects unsupported severity and duplicate ids', () => {
        expect(() =>
            validateOutput('review', {
                issues: [{ ...validReviewIssue, severity: 'p3' }],
            }),
        ).toThrow();

        expect(() =>
            validateOutput('review', { issues: [validReviewIssue, validReviewIssue] }),
        ).toThrow('review ids must be unique');
    });

    it('requires a known dimension and its assigned id prefix', () => {
        expect(() =>
            validateOutput('review', {
                issues: [{ ...validReviewIssue, id: 'logic-1' }],
            }),
        ).toThrow('id for state-lifecycle must start with life-');

        expect(() =>
            validateOutput('review', {
                issues: [{ ...validReviewIssue, dimension: 'database' }],
            }),
        ).toThrow();
    });

    it('requires legacy exposure and a low-likelihood scenario', () => {
        expect(() =>
            validateOutput('review', {
                issues: [{ ...validReviewIssue, nature: 'exposed_legacy', scenario: undefined }],
            }),
        ).toThrow();

        expect(() =>
            validateOutput('review', {
                issues: [{ ...validReviewIssue, likelihood: 'low', scenario: undefined }],
            }),
        ).toThrow();
    });

    it('requires scenarios for cross-boundary proof dimensions', () => {
        const cases = [
            { dimension: 'architecture', id: 'arch-1' },
            { dimension: 'security-privacy', id: 'sec-1' },
            { dimension: 'state-lifecycle', id: 'life-1' },
        ] as const;

        for (const { dimension, id } of cases) {
            expect(() =>
                validateOutput('review', {
                    issues: [
                        {
                            ...validReviewIssue,
                            dimension,
                            id,
                            scenario: undefined,
                        },
                    ],
                }),
            ).toThrow(`${dimension} findings require scenario`);
        }

        expect(() =>
            validateOutput('review', {
                issues: [
                    {
                        ...validReviewIssue,
                        dimension: 'correctness',
                        id: 'logic-1',
                        scenario: undefined,
                    },
                ],
            }),
        ).not.toThrow();
    });

    it('keeps verification fields specific to each verdict', () => {
        expect(() =>
            validateOutput('verify', {
                verifications: [
                    {
                        blocks_release: true,
                        evidence: 'The completion has no Session comparison.',
                        id: 'life-1',
                        verdict: 'confirmed',
                    },
                ],
            }),
        ).not.toThrow();

        expect(() =>
            validateOutput('verify', {
                verifications: [
                    {
                        evidence: 'Not valid for this verdict.',
                        id: 'life-1',
                        reason: 'A Session guard exists upstream.',
                        verdict: 'false_positive',
                    },
                ],
            }),
        ).toThrow();
    });

    it('rejects duplicate verification and consolidation ids', () => {
        const falsePositive = {
            id: 'life-1',
            reason: 'A Session guard exists upstream.',
            verdict: 'false_positive',
        } as const;

        expect(() =>
            validateOutput('verify', { verifications: [falsePositive, falsePositive] }),
        ).toThrow('verification ids must be unique');

        expect(() =>
            validateOutput('consolidate', {
                same_root: [
                    { id: 'life-2', same_root_as: 'logic-1' },
                    { id: 'life-2', same_root_as: 'arch-1' },
                ],
            }),
        ).toThrow('consolidation ids must be unique');
    });

    it('preserves entry-mode routing and delegated read-only boundaries', async () => {
        const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
        const reviewPrompt = await readFile(
            new URL('../references/review-prompt.md', import.meta.url),
            'utf8',
        );
        const deepWorkflow = await readFile(
            new URL('../references/deep-workflow.md', import.meta.url),
            'utf8',
        );

        expect(skill).toContain('| Light | Ordinary review requests');
        expect(skill).toContain('| Quick | "quick deep review"');
        expect(skill).toContain('| Deep  | Explicit `$deep-review`');
        expect(skill).toContain('Do not silently escalate light or quick mode to deep mode.');
        expect(reviewPrompt).toContain('Do not edit files, post comments, or mutate GitHub state.');
        expect(deepWorkflow).toContain('Delegated discovery and verification stay read-only');
    });
});
