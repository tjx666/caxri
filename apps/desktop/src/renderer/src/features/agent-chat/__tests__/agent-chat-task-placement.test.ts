import type { PaneLayout } from '@caxri/protocol';
import {
    agentSideChatTabPath,
    agentTaskTabPath,
    agentTurnReviewTabPath,
    createPaneLayout,
    findResourceTabs,
    openResource,
    splitTabIntoPane,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { planAgentChatTaskTabPlacement } from '../agent-chat-task-placement';

function ids(): () => string {
    let next = 0;
    return () => `id-${++next}`;
}

const chat = { kind: 'terminal', terminalId: 'chat' } as const;
const firstTask = agentTaskTabPath('chat', 'task-1');
const secondTask = agentTaskTabPath('chat', 'task-2');

function tabId(layout: PaneLayout, path: string): string {
    const found = findResourceTabs(layout, { kind: 'file', path }).at(0);
    if (!found) throw new Error(`No tab for ${path}`);
    return found.tab.id;
}

/**
 * The layout after the first task tab was split off to the right of the Chat.
 */
function withTaskSidePane(): { layout: PaneLayout; chatPaneId: string } {
    const id = ids();
    let layout = createPaneLayout(chat, id);
    const chatPaneId = layout.root.id;
    layout = openResource(layout, { kind: 'file', path: firstTask }, { paneId: chatPaneId }, id);
    layout = splitTabIntoPane(layout, tabId(layout, firstTask), chatPaneId, 'right', id);
    return { layout, chatPaneId };
}

describe('planAgentChatTaskTabPlacement', () => {
    it('splits the first task tab off to the right of the Chat', () => {
        const layout = createPaneLayout(chat, ids());
        expect(planAgentChatTaskTabPlacement(layout, 'chat', firstTask)).toEqual({
            kind: 'split',
            chatPaneId: layout.root.id,
        });
    });

    it('focuses a task tab that is already open', () => {
        const { layout } = withTaskSidePane();
        expect(planAgentChatTaskTabPlacement(layout, 'chat', firstTask)).toEqual({
            kind: 'select',
            tabId: tabId(layout, firstTask),
        });
    });

    it('collects later task tabs in the existing side pane', () => {
        const { layout } = withTaskSidePane();
        const sidePane = findResourceTabs(layout, { kind: 'file', path: firstTask }).at(0)?.pane;
        expect(planAgentChatTaskTabPlacement(layout, 'chat', secondTask)).toEqual({
            kind: 'open',
            paneId: sidePane?.id,
        });
    });

    it('opens a turn review in the side pane the task tabs use', () => {
        const { layout } = withTaskSidePane();
        const sidePane = findResourceTabs(layout, { kind: 'file', path: firstTask }).at(0)?.pane;
        expect(
            planAgentChatTaskTabPlacement(layout, 'chat', agentTurnReviewTabPath('chat', 'turn-1')),
        ).toEqual({ kind: 'open', paneId: sidePane?.id });
    });

    it('opens a side chat in the side pane the task tabs use', () => {
        const { layout } = withTaskSidePane();
        const sidePane = findResourceTabs(layout, { kind: 'file', path: firstTask }).at(0)?.pane;
        expect(planAgentChatTaskTabPlacement(layout, 'chat', agentSideChatTabPath('chat'))).toEqual(
            { kind: 'open', paneId: sidePane?.id },
        );
    });

    it('splits again when the pane to the right holds no task tab', () => {
        const id = ids();
        let layout = createPaneLayout(chat, id);
        const chatPaneId = layout.root.id;
        layout = openResource(
            layout,
            { kind: 'file', path: '/project/a.ts' },
            { paneId: chatPaneId },
            id,
        );
        layout = splitTabIntoPane(layout, tabId(layout, '/project/a.ts'), chatPaneId, 'right', id);
        expect(planAgentChatTaskTabPlacement(layout, 'chat', firstTask)).toEqual({
            kind: 'split',
            chatPaneId,
        });
    });

    it('falls back to the active pane when the Chat is not in the layout', () => {
        const layout = createPaneLayout({ kind: 'terminal', terminalId: 'other' }, ids());
        expect(planAgentChatTaskTabPlacement(layout, 'chat', firstTask)).toEqual({
            kind: 'active',
        });
    });
});
