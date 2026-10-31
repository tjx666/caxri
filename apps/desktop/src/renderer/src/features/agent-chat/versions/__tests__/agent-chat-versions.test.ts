import type { AgentChatItem, AgentChatSnapshot, AgentChatVersionContent } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatSnapshotWithVersions,
    agentChatVersionGroups,
    agentChatVersionKey,
    agentChatVersionView,
    selectAgentChatVersion,
} from '../agent-chat-versions';

/**
 * A conversation of user messages, each starting its own turn with one reply.
 */
function conversation(...turnIds: string[]): AgentChatVersionContent {
    return {
        items: turnIds.flatMap((turnId): AgentChatItem[] => [
            { id: `${turnId}:user`, type: 'userMessage', text: turnId, turnId },
            {
                id: `${turnId}:reply`,
                type: 'agentMessage',
                text: `re ${turnId}`,
                turnId,
                streaming: false,
            },
        ]),
        turns: turnIds.map((id) => ({ id, status: 'completed' })),
    };
}

const texts = (view: { items: readonly AgentChatItem[] }) =>
    view.items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));

const summary = (
    id: string,
    anchorTurnId: string | null,
    parentVersionId: string | null = null,
) => ({
    id,
    anchorTurnId,
    parentVersionId,
    createdAt: 0,
});

describe('agentChatVersionView', () => {
    // Messages 1-3 were sent, message 2 was edited into 2b: version `v1` holds the original 2 and 3.
    const current = conversation('t1', 't2b');
    const groups = agentChatVersionGroups([summary('v1', 't1')]);
    const contents = new Map([['v1', conversation('t2', 't3')]]);

    it('shows the current version with a switcher on the edited message', () => {
        const view = agentChatVersionView(current, true, groups, new Map(), contents);
        expect(texts(view)).toEqual(['t1', 't2b']);
        expect(view.isViewingEarlier).toBe(false);
        expect(view.switchers.get('t2b:user')).toMatchObject({ index: 1, count: 2 });
    });

    it('swaps the tail for the selected earlier version, read-only', () => {
        const key = agentChatVersionKey(null, 't1');
        const view = agentChatVersionView(current, true, groups, new Map([[key, 'v1']]), contents);
        expect(texts(view)).toEqual(['t1', 't2', 't3']);
        expect(view.turns.map((turn) => turn.id)).toEqual(['t1', 't2', 't3']);
        expect(view.switchers.get('t2:user')).toMatchObject({ index: 0, count: 2 });
        expect(view.earlierItemIds).toEqual(
            new Set(['t2:user', 't2:reply', 't3:user', 't3:reply']),
        );
        expect(view.isViewingEarlier).toBe(true);
    });

    it('keeps the current version on screen until the selected one arrives', () => {
        const key = agentChatVersionKey(null, 't1');
        const view = agentChatVersionView(current, true, groups, new Map([[key, 'v1']]), new Map());
        expect(texts(view)).toEqual(['t1', 't2b']);
        expect(view.missing).toEqual(['v1']);
        expect(view.switchers.get('t2b:user')).toMatchObject({ index: 0 });
    });

    it('offers a version of the first message only when the conversation is held from its start', () => {
        const first = agentChatVersionGroups([summary('v0', null)]);
        const fromStart = agentChatVersionView(current, true, first, new Map(), new Map());
        expect(fromStart.switchers.get('t1:user')).toMatchObject({ index: 1, count: 2 });
        const cut = agentChatVersionView(current, false, first, new Map(), new Map());
        expect(cut.switchers.size).toBe(0);
    });

    it('switches a version kept inside an earlier one', () => {
        // Message 3 was edited (v-inner, anchored on t2), then message 2 (v-outer holds t2 and t3b).
        const nested = agentChatVersionGroups([
            summary('inner', 't2', 'outer'),
            summary('outer', 't1'),
        ]);
        const stored = new Map([
            ['outer', conversation('t2', 't3b')],
            ['inner', conversation('t3')],
        ]);
        const outer = agentChatVersionKey(null, 't1');
        const inner = agentChatVersionKey('outer', 't2');
        const once = agentChatVersionView(
            current,
            true,
            nested,
            new Map([[outer, 'outer']]),
            stored,
        );
        expect(texts(once)).toEqual(['t1', 't2', 't3b']);
        expect(once.switchers.get('t3b:user')).toMatchObject({ index: 1, count: 2 });
        const twice = agentChatVersionView(
            current,
            true,
            nested,
            new Map([
                [outer, 'outer'],
                [inner, 'inner'],
            ]),
            stored,
        );
        expect(texts(twice)).toEqual(['t1', 't2', 't3']);
    });
});

describe('selectAgentChatVersion', () => {
    it('picks a version, and clears the switch point and those inside it for the last one', () => {
        const switcher = {
            key: agentChatVersionKey(null, 't1'),
            index: 1,
            count: 2,
            versionIds: ['outer', undefined],
        };
        const picked = selectAgentChatVersion(new Map(), switcher, 0);
        expect([...picked]).toEqual([[switcher.key, 'outer']]);
        const nested = new Map([...picked, [agentChatVersionKey('outer', 't2'), 'inner']]);
        expect(selectAgentChatVersion(nested, switcher, 1).size).toBe(0);
    });
});

describe('agentChatSnapshotWithVersions', () => {
    it('hides the running turn while an earlier version is on screen', () => {
        const snapshot: AgentChatSnapshot = {
            ...emptyAgentChatSnapshot('chat'),
            ...conversation('t1', 't2b'),
            activeTurnId: 't2b',
        };
        const groups = agentChatVersionGroups([summary('v1', 't1')]);
        const contents = new Map([['v1', conversation('t2')]]);
        const live = agentChatVersionView(snapshot, true, groups, new Map(), contents);
        expect(agentChatSnapshotWithVersions(snapshot, live)).toBe(snapshot);
        const earlier = agentChatVersionView(
            snapshot,
            true,
            groups,
            new Map([[agentChatVersionKey(null, 't1'), 'v1']]),
            contents,
        );
        expect(agentChatSnapshotWithVersions(snapshot, earlier).activeTurnId).toBeUndefined();
    });
});
