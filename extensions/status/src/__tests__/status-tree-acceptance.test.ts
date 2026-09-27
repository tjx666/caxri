import type { ProjectStatusAcceptance, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

const ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const URL = `https://app.lobehub.com/acceptance/${ID}`;

/**
 * Acceptance rows follow the branch row, in the order the Server ranked them, so the first report is the second child
 * of the repository node.
 */
function acceptanceRow(acceptance: ProjectStatusAcceptance) {
    const [report] =
        buildRepoNode({
            id: 'repo',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            acceptances: [acceptance],
            linearIssues: [],
            errors: [],
        }).children?.slice(1, 2) ?? [];
    return report;
}

function iconId(node: ReturnType<typeof acceptanceRow>): string | undefined {
    return node.item.iconPath?.id;
}

describe('Status extension acceptance rows', () => {
    it('states the check tally and the round an acceptance row answers for', () => {
        const report = acceptanceRow({
            id: ID,
            state: 'failure',
            title: 'Recover a stalled diff',
            url: `${URL}?turn=1`,
            round: 1,
            status: 'repairing',
            verdict: 'failed',
            passedChecks: 4,
            totalChecks: 12,
            roundCount: 2,
        });

        expect(report.item.label).toBe('Recover a stalled diff');
        // Neither the tally nor the round is carried by the glyph, so the row is the only place they can be stated.
        expect(report.item.description).toBe('4/12 · r1');
        // The accessible name keeps the words `r1` would be read out as.
        expect(report.item.accessibilityInformation?.label).toContain('4/12 · round 1');
        expect(iconId(report)).toBe('shield-x');
        const tooltip = report.item.tooltip as TreeItemRichTooltip;
        expect(tooltip.badge).toEqual({ label: 'Repairing', tone: 'danger' });
        expect(tooltip.rows?.slice(0, 3)).toEqual([
            { label: 'verdict', value: 'Checks failed' },
            { label: 'checks', value: '4 of 12 passed' },
            { label: 'round', value: '1' },
        ]);
        // `richTooltip` appends the destination as the trailing row, so the hover card can open it directly.
        expect(tooltip.rows?.at(-1)).toMatchObject({ label: 'link' });
    });

    it('renders a report whose lookup failed as an alarming row that still opens the link', () => {
        const report = acceptanceRow({ id: ID, state: 'unknown', url: URL });

        expect(report.item.label).toBe('Acceptance report');
        // Says so in words as well as in the glyph: the row has no tally because nobody could read the report.
        expect(report.item.description).toBe('unknown');
        expect(iconId(report)).toBe('shield-alert');
        expect(report.item.command?.arguments?.[0]).toBe(URL);
    });

    it('says the latest round answered a link that pinned none', () => {
        const report = acceptanceRow({
            id: ID,
            state: 'success',
            status: 'accepted',
            verdict: 'passed',
            passedChecks: 12,
            totalChecks: 12,
            roundCount: 3,
        });

        expect(report.item.description).toBe('12/12 · r3');
        expect(report.item.accessibilityInformation?.label).toContain('12/12 · latest of 3');
        const tooltip = report.item.tooltip as TreeItemRichTooltip;
        expect(tooltip.rows).toContainEqual({ label: 'round', value: 'latest of 3' });
        expect(iconId(report)).toBe('shield-check');
    });

    /**
     * A verification round can stay in flight for an hour, so the row states it with a static glyph. The spinner the
     * shared state vocabulary gives `pending` is reserved for a CI check that is actually executing, and spending it
     * here both animated an hour-long wait and left the row indistinguishable from the checks above it.
     */
    it('draws a verification still in flight as a static acceptance glyph, never the spinner', () => {
        const report = acceptanceRow({
            id: ID,
            state: 'pending',
            status: 'verifying',
            passedChecks: 1,
            totalChecks: 1,
            round: 2,
        });

        expect(iconId(report)).toBe('shield-ellipsis');
        expect(report.item.description).toBe('1/1 · r2');
    });
});
