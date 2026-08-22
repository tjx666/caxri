import { describe, expect, it } from 'vitest';

import type { PaneLayoutNode, PaneNode, PaneResource, PaneTab } from '../pane-layout.js';
import {
    isRepeatablePaneResource,
    MAX_PANE_LAYOUT_PANES,
    paneLayoutSchema,
    paneResourceKey,
} from '../pane-layout.js';

const terminal = (terminalId: string): PaneResource => ({ kind: 'terminal', terminalId });
const file = (path: string): PaneResource => ({ kind: 'file', path });

function tab(id: string, resource: PaneResource): PaneTab {
    return { id, resource };
}

function pane(id: string, tabs: PaneTab[], activeTabId?: string): PaneNode {
    return { type: 'pane', id, tabs, activeTabId };
}

/**
 * A pane whose tab ids are derived from its own id, for the tests that care about resources rather than occurrences.
 */
function paneOf(id: string, ...resources: PaneResource[]): PaneNode {
    return pane(
        id,
        resources.map((resource, index) => tab(`${id}-tab-${index}`, resource)),
    );
}

function split(id: string, first: PaneLayoutNode, second: PaneLayoutNode): PaneLayoutNode {
    return { type: 'split', id, direction: 'horizontal', ratio: 0.5, first, second };
}

function failure(root: PaneLayoutNode, activePaneId?: string): string {
    const result = paneLayoutSchema.safeParse({ root, activePaneId });
    expect(result.success, 'expected the layout to be rejected').toBe(false);
    return result.error?.issues[0]?.message ?? '';
}

describe('pane layout contract', () => {
    it('accepts a Terminal and a document side by side in one tree', () => {
        const left = paneOf('pane-1', terminal('terminal-1'));
        const right = paneOf('pane-2', file('src/index.ts'));
        const parsed = paneLayoutSchema.safeParse({
            root: split('split-1', left, right),
            activePaneId: 'pane-1',
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts a Terminal beside a document in a single pane', () => {
        const root = paneOf('pane-1', terminal('terminal-1'), file('README.md'));
        expect(paneLayoutSchema.safeParse({ root }).success).toBe(true);
    });

    it('lets a document occupy several panes, each occurrence with its own tab id', () => {
        const left = paneOf('pane-1', file('src/index.ts'));
        const right = paneOf('pane-2', file('src/index.ts'));
        expect(paneLayoutSchema.safeParse({ root: split('split-1', left, right) }).success).toBe(
            true,
        );
    });

    it('keeps a Terminal in exactly one pane', () => {
        const left = paneOf('pane-1', terminal('terminal-1'));
        const right = paneOf('pane-2', terminal('terminal-1'));
        expect(failure(split('split-1', left, right))).toBe(
            'A Terminal cannot be attached to two panes',
        );
    });

    it('rejects the same resource listed twice in one pane', () => {
        const root = paneOf('pane-1', file('src/index.ts'), file('src/index.ts'));
        expect(failure(root)).toBe('A pane cannot list the same resource twice');
    });

    it('rejects a tab id reused anywhere in the tree', () => {
        const left = pane('pane-1', [tab('tab-1', file('a.ts'))]);
        const right = pane('pane-2', [tab('tab-1', file('b.ts'))]);
        expect(failure(split('split-1', left, right))).toBe('Pane layout reuses a tab id');
    });

    it('requires the active tab to belong to its own pane', () => {
        const left = pane('pane-1', [tab('tab-1', file('a.ts'))], 'tab-2');
        const right = pane('pane-2', [tab('tab-2', file('b.ts'))]);
        expect(failure(split('split-1', left, right))).toBe(
            'The active tab must belong to its pane',
        );
    });

    it('requires the active pane to be a pane that exists', () => {
        const left = paneOf('pane-1', file('a.ts'));
        const right = paneOf('pane-2', file('b.ts'));
        const root = split('split-1', left, right);
        const message = 'The active pane is not a pane of the Workbench layout';
        expect(failure(root, 'split-1')).toBe(message);
        expect(failure(root, 'pane-3')).toBe(message);
    });

    it('allows an empty Workbench but not an empty pane inside a split', () => {
        expect(paneLayoutSchema.safeParse({ root: paneOf('pane-1') }).success).toBe(true);
        const left = paneOf('pane-1', file('a.ts'));
        const empty = paneOf('pane-2');
        expect(failure(split('split-1', left, empty))).toBe('Only a root pane may be empty');
    });

    it('caps the number of live panes', () => {
        let root: PaneLayoutNode = paneOf('pane-0', file('file-0.ts'));
        for (let index = 1; index <= MAX_PANE_LAYOUT_PANES; index++) {
            root = split(`split-${index}`, root, paneOf(`pane-${index}`, file(`file-${index}.ts`)));
        }
        expect(failure(root)).toMatch(/exceeds \d+ (?:panes|nodes)/);
    });

    it('distinguishes a Terminal from a document of the same name', () => {
        const keys = [
            paneResourceKey(file('a.ts')),
            paneResourceKey(terminal('a.ts')),
            // Git diffs and Agent transcripts are documents on their own virtual paths.
            paneResourceKey(file('caxri-diff:repo-1/a.ts')),
        ];
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('marks every resource except a Terminal as repeatable', () => {
        expect(isRepeatablePaneResource(terminal('terminal-1'))).toBe(false);
        expect(isRepeatablePaneResource(file('a.ts'))).toBe(true);
    });
});
