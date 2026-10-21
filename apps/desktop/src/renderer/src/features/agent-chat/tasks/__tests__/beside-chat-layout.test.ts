import type { PaneLayout } from '@caxri/protocol';
import {
    agentContextTabPath,
    agentSideChatTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    agentTurnReviewTabPath,
    createPaneLayout,
    findResourceTabs,
    MAX_SPLIT_RATIO,
    openResource,
    splitTabIntoPane,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    besideChatSplitRatio,
    besideChatTabTerminalId,
    hasBesideChatArrangement,
} from '../beside-chat-layout';

function ids(): () => string {
    let next = 0;
    return () => `id-${++next}`;
}

/**
 * A Chat with `paths` opened in its pane, the first of them split off to `side`.
 */
function splitBeside(
    terminalId: string,
    paths: string[],
    side: 'right' | 'left' | 'down' = 'right',
): PaneLayout {
    const id = ids();
    let layout = createPaneLayout({ kind: 'terminal', terminalId }, id);
    const chatPaneId = layout.root.id;
    for (const path of paths)
        layout = openResource(layout, { kind: 'file', path }, { paneId: chatPaneId }, id);
    const first = findResourceTabs(layout, { kind: 'file', path: paths[0] }).at(0);
    if (!first) throw new Error('missing tab');
    layout = splitTabIntoPane(layout, first.tab.id, chatPaneId, side, id);
    return layout;
}

describe('besideChatTabTerminalId', () => {
    it('names the owning Chat of every tab that opens beside it', () => {
        expect(besideChatTabTerminalId(agentTaskTabPath('chat', 'task'))).toBe('chat');
        expect(besideChatTabTerminalId(agentTurnReviewTabPath('chat', 'turn'))).toBe('chat');
        expect(besideChatTabTerminalId(agentSideChatTabPath('chat'))).toBe('chat');
        expect(besideChatTabTerminalId(agentContextTabPath('chat'))).toBe('chat');
    });

    it('ignores files and other virtual tabs', () => {
        expect(besideChatTabTerminalId('/project/a.ts')).toBeUndefined();
        expect(besideChatTabTerminalId(agentTranscriptTabPath('chat'))).toBeUndefined();
    });
});

describe('hasBesideChatArrangement', () => {
    it('holds for a side pane right of its own Chat', () => {
        const layout = splitBeside('chat', [agentContextTabPath('chat')]);
        expect(hasBesideChatArrangement(layout)).toBe(true);
    });

    it('does not hold for a side pane beside a different Chat', () => {
        const layout = splitBeside('chat', [agentContextTabPath('other')]);
        expect(hasBesideChatArrangement(layout)).toBe(false);
    });

    it('does not hold for a split the user arranged with a file in it', () => {
        const id = ids();
        let layout = createPaneLayout({ kind: 'terminal', terminalId: 'chat' }, id);
        const chatPaneId = layout.root.id;
        layout = openResource(
            layout,
            { kind: 'file', path: '/project/a.ts' },
            { paneId: chatPaneId },
            id,
        );
        const tab = findResourceTabs(layout, { kind: 'file', path: '/project/a.ts' }).at(0);
        if (!tab) throw new Error('missing tab');
        layout = splitTabIntoPane(layout, tab.tab.id, chatPaneId, 'right', id);
        layout = openResource(
            layout,
            { kind: 'file', path: agentSideChatTabPath('chat') },
            { paneId: layout.activePaneId },
            id,
        );
        expect(hasBesideChatArrangement(layout)).toBe(false);
    });

    it('does not hold for a side pane below or left of the Chat', () => {
        const below = splitBeside('chat', [agentSideChatTabPath('chat')], 'down');
        expect(hasBesideChatArrangement(below)).toBe(false);
        const left = splitBeside('chat', [agentSideChatTabPath('chat')], 'left');
        expect(hasBesideChatArrangement(left)).toBe(false);
    });

    it('does not hold for a single pane', () => {
        const layout = createPaneLayout({ kind: 'terminal', terminalId: 'chat' }, ids());
        expect(hasBesideChatArrangement(layout)).toBe(false);
    });
});

describe('besideChatSplitRatio', () => {
    it('caps the Chat at its readable width on a wide host', () => {
        expect(besideChatSplitRatio(1604)).toBeCloseTo(800 / 1600);
        expect(besideChatSplitRatio(2404)).toBeCloseTo(800 / 2400);
    });

    it('keeps the side pane at its minimum and gives the Chat the rest on a medium host', () => {
        // 1024px window less a 230px Primary Sidebar and its divider: the old fixed half left the Chat ~390px.
        const host = 1024 - 230 - 6;
        const ratio = besideChatSplitRatio(host);
        expect(ratio).toBeDefined();
        expect((host - 4) * (1 - (ratio ?? 0))).toBeCloseTo(360);
    });

    it('refuses to split when both minimums cannot fit', () => {
        expect(besideChatSplitRatio(420 + 360 + 4)).toBeDefined();
        expect(besideChatSplitRatio(420 + 360 + 3)).toBeUndefined();
        expect(besideChatSplitRatio(NaN)).toBeUndefined();
    });

    it('never exceeds the reducer bounds', () => {
        expect(besideChatSplitRatio(800 + 360 + 4)).toBeLessThanOrEqual(MAX_SPLIT_RATIO);
    });
});
