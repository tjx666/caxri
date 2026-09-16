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
        expect(report.item.description).toBe('4/12 · round 1');
        expect(iconId(report)).toBe('circle-x');
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

    it('renders a report Caxri recognized but never read as an inert row that still opens the link', () => {
        const report = acceptanceRow({ id: ID, state: 'unknown', url: URL });

        expect(report.item.label).toBe('Acceptance report');
        expect(report.item.description).toBeUndefined();
        expect(iconId(report)).toBe('circle-dot');
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

        expect(report.item.description).toBe('12/12 · latest of 3');
        expect(iconId(report)).toBe('circle-check');
    });
});
