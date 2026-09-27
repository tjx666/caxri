import type { ProjectStatusOverviewAcceptance } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { acceptanceAriaLabel, acceptanceChipLabel, acceptanceTooltip } from '../acceptance-label';

const ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function acceptance(
    overrides: Partial<ProjectStatusOverviewAcceptance> = {},
): ProjectStatusOverviewAcceptance {
    return { id: ID, state: 'pending', source: 'pull-request', ...overrides };
}

describe('acceptance chip label', () => {
    it('leads with the check tally, which is the densest true statement it can make', () => {
        expect(
            acceptanceChipLabel(
                acceptance({ passedChecks: 11, totalChecks: 12, status: 'delivered' }),
            ),
        ).toBe('11/12');
    });

    it('falls back to the lifecycle word when no round has produced a tally', () => {
        expect(acceptanceChipLabel(acceptance({ status: 'verifying' }))).toBe('Verifying');
        expect(acceptanceChipLabel(acceptance({ status: 'delivered' }))).toBe('Awaiting review');
    });

    it('says the report could not be read rather than naming the bare noun', () => {
        expect(acceptanceChipLabel(acceptance({ state: 'unknown' }))).toBe('Unknown');
    });

    it('never prints the report id, which names a private record and tells a reader nothing', () => {
        for (const value of [
            acceptanceChipLabel(acceptance({ status: 'accepted' })),
            acceptanceAriaLabel(acceptance({ status: 'accepted', title: 'Fix the diff' })),
            JSON.stringify(
                acceptanceTooltip(acceptance({ status: 'accepted', title: 'Fix the diff' })),
            ),
        ])
            expect(value).not.toContain(ID);
    });
});

describe('acceptance chip accessible name', () => {
    it('speaks everything the glyph and the tint carry', () => {
        expect(
            acceptanceAriaLabel(
                acceptance({
                    url: `https://app.lobehub.com/acceptance/${ID}`,
                    title: 'Recover a stalled diff',
                    round: 2,
                    status: 'delivered',
                    verdict: 'passed',
                    passedChecks: 11,
                    totalChecks: 12,
                }),
            ),
        ).toBe(
            'Open acceptance report, Recover a stalled diff, Round 2, Awaiting review, Checks passed, 11 of 12 checks passed, From the pull request description',
        );
    });

    it('does not promise a destination a link without a URL cannot offer, and counts the rest', () => {
        expect(acceptanceAriaLabel(acceptance({ status: 'verifying' }), 2)).toBe(
            'Acceptance report, Verifying, From the pull request description, 2 more reports',
        );
    });
});

describe('acceptance hover card', () => {
    it('says which round answered when the link pinned one', () => {
        expect(
            acceptanceTooltip(
                acceptance({ title: 'Recover a stalled diff', round: 2, status: 'repairing' }),
            ),
        ).toEqual({
            eyebrow: 'Acceptance report',
            title: 'Recover a stalled diff',
            details: ['Repairing · Round 2'],
            notes: ['From the pull request description'],
            hint: undefined,
        });
    });

    it('says the latest round answered an unpinned link on a multi-round report', () => {
        expect(
            acceptanceTooltip(
                acceptance({ roundCount: 3, status: 'accepted', url: 'https://example.com/a' }),
            ),
        ).toEqual({
            eyebrow: undefined,
            title: 'Acceptance report',
            details: ['Accepted · Latest of 3 rounds'],
            notes: ['From the pull request description'],
            hint: 'Click to open the report',
        });
    });

    it('names the source and counts the reports it is leading', () => {
        expect(
            acceptanceTooltip(acceptance({ source: 'conversation' }), [acceptance(), acceptance()])
                .notes,
        ).toEqual(['From this conversation', 'Also referenced: 2 more reports']);
    });
});
