import { describe, expect, it } from 'vitest';

import { rebindReportDocument } from './report-head';

const baseInput = {
    commit: 'new-head',
    directory: '.records/case/round-1',
    entry: '在 new-head 上执行 Caxri Electron 桌面验收。',
    fromCommit: 'old-head',
    reason: 'Workflow-only repair changed the exact delivery head.',
};

function unfinishedReport(overrides: Record<string, unknown> = {}) {
    return {
        commit: 'old-head',
        createdAt: '2026-08-13T08:00:00.000Z',
        entry: '在 old-head 上执行 Caxri Electron 桌面验收。',
        ...overrides,
    };
}

describe('rebindReportDocument', () => {
    it('rebinds an unfinished report and appends an audit record', () => {
        const rebound = rebindReportDocument(unfinishedReport(), {
            ...baseInput,
            createdAt: '2026-08-14T00:00:00.000Z',
        });

        expect(rebound).toMatchObject({
            commit: 'new-head',
            createdAt: '2026-08-14T00:00:00.000Z',
            entry: baseInput.entry,
            headRebinds: [
                {
                    fromCommit: 'old-head',
                    reason: baseInput.reason,
                    reboundAt: '2026-08-14T00:00:00.000Z',
                    toCommit: 'new-head',
                },
            ],
        });
    });

    it('rejects rebinding an already-finalized report', () => {
        const finalized = unfinishedReport({ summary: { conclusion: '本轮结论。', score: 100 } });

        expect(() => rebindReportDocument(finalized, baseInput)).toThrow(
            'A finalized Acceptance report cannot be rebound',
        );
    });

    it('rejects a replacement commit identical to --from-commit', () => {
        expect(() =>
            rebindReportDocument(unfinishedReport(), {
                ...baseInput,
                commit: 'old-head',
                fromCommit: 'old-head',
            }),
        ).toThrow('Acceptance report replacement commit must differ from --from-commit');
    });

    it('rejects a stale --from-commit that no longer matches the report head', () => {
        expect(() =>
            rebindReportDocument(unfinishedReport({ commit: 'other-head' }), baseInput),
        ).toThrow('Acceptance report commit does not match --from-commit');
    });
});
