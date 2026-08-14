import { describe, expect, it } from 'vitest';

import { createFinalResponseSummary, formatFinalizationSummary } from '../finalization';

describe('Go finalization response', () => {
    it('carries Workflow improvements and automation candidates into the final receipt', () => {
        const finalResponse = createFinalResponseSummary({
            notes: {
                token_waste: [
                    { text: 'Resolve registry metadata before dependency installation.' },
                ],
                workflow: [{ text: 'Expose command-level state help.' }],
            },
            runBudget: { routedWork: [{ title: 'Add a reusable package-line resolver.' }] },
        });

        const output = formatFinalizationSummary({
            deliveredAt: null,
            finalResponse,
            headSha: 'head-1',
            issues: [{ number: 92, projectStatus: 'Done', state: 'CLOSED' }],
            mergeSha: 'merge-1',
            path: 'finalization.json',
            pullRequestNumber: 118,
            receiptVersion: 2,
            verifiedAt: '2026-08-13T08:00:00.000Z',
        });

        expect(output).toContain('Workflow 改进');
        expect(output).toContain('Expose command-level state help.');
        expect(output).toContain('自动化候选');
        expect(output).toContain('Add a reusable package-line resolver.');
    });

    it('uses explicit none entries instead of allowing either audit to disappear', () => {
        expect(
            createFinalResponseSummary({
                notes: { token_waste: [], workflow: [] },
                runBudget: { routedWork: [] },
            }),
        ).toEqual({
            automationCandidates: ['本次运行未记录新增自动化候选。'],
            workflowImprovements: ['本次运行未记录新增 Workflow 改进。'],
        });
    });
});
