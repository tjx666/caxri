import type { ProjectStatusOverviewLinearIssue } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    hasOpenableLinearIssue,
    linearIssueAriaLabel,
    linearIssueTooltip,
} from '../linear-issue-label';

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
        const extra: ProjectStatusOverviewLinearIssue[] = [
            { identifier: 'XYZ-7', source: 'branch', url: 'https://linear.app/acme/issue/XYZ-7' },
            { identifier: 'XYZ-8', source: 'conversation' },
        ];
        expect(linearIssueTooltip(resolved, extra)).toEqual({
            eyebrow: 'ABC-42',
            title: 'Router monitoring',
            details: ['In Progress'],
            notes: ['From the pull request description'],
            links: {
                label: 'Also referenced',
                items: [
                    { label: 'XYZ-7', href: 'https://linear.app/acme/issue/XYZ-7' },
                    { label: 'XYZ-8', href: undefined },
                ],
            },
            hint: 'Click to open ABC-42 in Linear',
        });
    });

    it('needs an enterable hover card only when another issue can be opened', () => {
        expect(hasOpenableLinearIssue([])).toBe(false);
        expect(hasOpenableLinearIssue([{ identifier: 'XYZ-8', source: 'conversation' }])).toBe(
            false,
        );
        expect(
            hasOpenableLinearIssue([
                {
                    identifier: 'XYZ-7',
                    source: 'branch',
                    url: 'https://linear.app/acme/issue/XYZ-7',
                },
            ]),
        ).toBe(true);
    });

    it('drops the lines an unresolved issue has nothing to put in', () => {
        expect(linearIssueTooltip({ identifier: 'ABC-42', source: 'branch' })).toEqual({
            eyebrow: undefined,
            title: 'ABC-42',
            details: [],
            notes: ['From the branch name'],
            links: undefined,
            hint: undefined,
        });
    });
});
