import { describe, expect, it } from 'vitest';

import type {
    PrimarySidebarProjectNode,
    PrimarySidebarSubagentNode,
} from '../primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    primarySidebarHorizontalIntent,
    primarySidebarPinnedRowId,
    primarySidebarSubagentRowId,
} from '../primary-sidebar-tree';

/**
 * A host Session row's child disclosure (issue #4065): the tree stamps whether its child rows show, and Left/Right fold
 * and unfold them before moving focus.
 */
const projects: PrimarySidebarProjectNode[] = [{ id: 'alpha', sessionIds: ['alpha-1', 'alpha-2'] }];

const subagents = new Map<string, PrimarySidebarSubagentNode>([
    ['alpha-1', { taskIds: ['t1'], terminalId: 'chat-1' }],
]);

function childrenExpanded(isExpanded: boolean) {
    return (sessionId: string): boolean | undefined =>
        sessionId === 'alpha-1' ? isExpanded : undefined;
}

describe('host Session child disclosure', () => {
    it('stamps the disclosure state on a host row only', () => {
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            { expanded: true, sessionIds: ['alpha-1'] },
            subagents,
            undefined,
            childrenExpanded(true),
        );
        expect(rows.find((row) => row.id === 'alpha-1')?.childrenExpanded).toBe(true);
        expect(
            rows.find((row) => row.id === primarySidebarPinnedRowId('alpha-1'))?.childrenExpanded,
        ).toBe(true);
        expect(rows.find((row) => row.id === 'alpha-2')).not.toHaveProperty('childrenExpanded');
    });

    it('folds an open host on Left and steps into it on Right', () => {
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            subagents,
            undefined,
            childrenExpanded(true),
        );
        const host = rows.find((row) => row.id === 'alpha-1')!;
        expect(primarySidebarHorizontalIntent(rows, host, true, 'ArrowLeft')).toEqual({
            sessionChildrenExpanded: false,
        });
        expect(primarySidebarHorizontalIntent(rows, host, true, 'ArrowRight')).toEqual({
            focusRowId: primarySidebarSubagentRowId('alpha-1', 't1'),
        });
    });

    it('unfolds a folded host on Right and moves to its heading on Left', () => {
        // A folded host lists no child rows, which is what its node map already says.
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            new Map(),
            undefined,
            childrenExpanded(false),
        );
        const host = rows.find((row) => row.id === 'alpha-1')!;
        expect(primarySidebarHorizontalIntent(rows, host, true, 'ArrowRight')).toEqual({
            sessionChildrenExpanded: true,
        });
        expect(primarySidebarHorizontalIntent(rows, host, true, 'ArrowLeft')).toEqual({
            focusRowId: 'alpha',
        });
    });
});
