import type { ProjectStatusOverviewLinearIssue } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { linearIssueAriaLabel, linearIssueTooltipLines } from '../linear-issue-label';

const resolved: ProjectStatusOverviewLinearIssue = {
    identifier: 'ABC-42',
    title: 'Router monitoring',
    url: 'https://linear.app/acme/issue/ABC-42',
    state: 'In Progress',
    stateType: 'started',
    stateColor: '#5E6AD2',
    source: 'pull-request',
};

describe('status bar Linear issue labels', () => {
    it('speaks everything the glyph and its tint carry, plus where the link came from', () => {
        expect(linearIssueAriaLabel(resolved)).toBe(
            'Open Linear issue ABC-42, Router monitoring, In Progress, From the pull request description',
        );
    });

    it('says the issue cannot be opened when it has no resolved URL', () => {
        expect(linearIssueAriaLabel({ identifier: 'ABC-42', source: 'conversation' })).toBe(
            'Linear issue ABC-42, From this conversation',
        );
    });

    it('counts the issues the chip could not show', () => {
        expect(linearIssueAriaLabel(resolved, 2)).toContain('2 more issues');
        expect(linearIssueAriaLabel(resolved, 1)).toContain('1 more issue');
    });

    it('stacks the hover card as title, state, source, then the issues it left out', () => {
        expect(
            linearIssueTooltipLines(resolved, [{ identifier: 'XYZ-7', source: 'branch' }]),
        ).toEqual([
            'ABC-42 Router monitoring',
            'In Progress',
            'From the pull request description',
            'Also referenced: XYZ-7',
        ]);
    });

    it('drops the lines an unresolved issue has nothing to put in', () => {
        expect(linearIssueTooltipLines({ identifier: 'ABC-42', source: 'branch' })).toEqual([
            'ABC-42',
            'From the branch name',
        ]);
    });
});
