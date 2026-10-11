import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatSnapshot } from '../agent/agent-chat-contract.js';
import { agentChatSnapshotSchema } from '../agent/agent-chat-contract.js';
import { applyAgentChatPatch } from '../agent/agent-chat-reducer.js';
import {
    clipAgentChatItemForMobile,
    clipAgentChatPatchForMobile,
    MOBILE_AGENT_CHAT_CLIP_MARKER,
    MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH,
    MOBILE_AGENT_CHAT_MAX_BYTES,
    mobileAgentChatMethods,
    windowAgentChatSnapshotForMobile,
} from '../mobile/mobile-agent-chat-contract.js';
import { mobileDashboardSessionSchema } from '../mobile/mobile-contract.js';

const message = (id: string, text: string, turnId = 'turn-1'): AgentChatItem => ({
    id,
    turnId,
    type: 'agentMessage',
    text,
    streaming: false,
});

const snapshot = (items: AgentChatItem[]): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision: 7,
    status: 'ready',
    truncated: false,
    items,
    turns: [{ id: 'turn-1', status: 'completed' }],
    requests: [],
});

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe('mobile Agent Chat projection', () => {
    it('projects the Chat surface on the primary Terminal so the phone never attaches a PTY to it', () => {
        const session = {
            id: 'session-1',
            projectId: 'project-1',
            displayTitle: 'Fix tests',
            projectTitle: 'Example',
            lastOpenedAt: 1,
            lastActivityState: 'idle',
            attentionEpoch: 0,
            hasUnread: false,
            primaryTerminal: {
                id: 'terminal-1',
                sessionId: 'session-1',
                kind: 'codex',
                lastProcessState: 'running',
                surface: 'chat',
            },
        };
        expect(mobileDashboardSessionSchema.parse(session).primaryTerminal?.surface).toBe('chat');
        expect(
            mobileDashboardSessionSchema.safeParse({
                ...session,
                primaryTerminal: { ...session.primaryTerminal, surface: 'pty' },
            }).success,
        ).toBe(false);
    });

    it('keeps the tail of a long reply so streamed deltas still continue it', () => {
        const long = message('item-1', `${'a'.repeat(10_000)}END`);
        const clipped = clipAgentChatItemForMobile(long) as Extract<
            AgentChatItem,
            { type: 'agentMessage' }
        >;
        expect(clipped.text.startsWith(MOBILE_AGENT_CHAT_CLIP_MARKER)).toBe(true);
        expect(clipped.text.endsWith('END')).toBe(true);
        expect(clipped.text.length).toBe(MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH + 1);
        const short = message('item-2', 'hello');
        expect(clipAgentChatItemForMobile(short)).toBe(short);
    });

    it('shares one diff budget across a file change, keeping every path', () => {
        const item: AgentChatItem = {
            id: 'change-1',
            type: 'fileChange',
            status: 'completed',
            changes: Array.from({ length: 4 }, (_, index) => ({
                path: `src/file-${index}.ts`,
                kind: 'update' as const,
                diff: `+${'d'.repeat(5_000)}`,
            })),
        };
        const clipped = clipAgentChatItemForMobile(item) as Extract<
            AgentChatItem,
            { type: 'fileChange' }
        >;
        expect(clipped.changes.map((change) => change.path)).toEqual(
            item.changes.map((change) => change.path),
        );
        expect(clipped.changes[0]?.diff).toBe(item.changes[0]?.diff);
        expect(clipped.changes[1]?.diff.endsWith(MOBILE_AGENT_CHAT_CLIP_MARKER)).toBe(true);
        expect(clipped.changes[3]?.diff).toBe('');
        expect(clipped.changes.map((change) => change.truncated)).toEqual([
            undefined,
            true,
            true,
            true,
        ]);
    });

    it('windows the newest items into one frame and marks older history as not shown', () => {
        const items = Array.from({ length: 40 }, (_, index) =>
            message(`item-${index}`, 'm'.repeat(3_000)),
        );
        const windowed = windowAgentChatSnapshotForMobile(snapshot(items));
        expect(bytes(windowed)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(windowed.truncated).toBe(true);
        expect(windowed.items.at(-1)?.id).toBe('item-39');
        expect(windowed.items.length).toBeLessThan(items.length);
        expect(agentChatSnapshotSchema.safeParse(windowed).success).toBe(true);
    });

    it('keeps an image message in the window by leaving its thumbnails for the phone to fetch', () => {
        // Desktop thumbnails reach 48 KiB each, so one image message alone would fill the frame.
        const thumbnail = `data:image/jpeg;base64,${'A'.repeat(40_000)}`;
        const withImages: AgentChatItem = {
            id: 'item-images',
            turnId: 'turn-1',
            type: 'userMessage',
            text: 'Look at these',
            images: [{ thumbnail }, { thumbnail }, {}],
        };
        const windowed = windowAgentChatSnapshotForMobile(
            snapshot([message('item-0', 'Earlier'), withImages, message('item-2', 'Reply')]),
        );
        expect(windowed.items.map((item) => item.id)).toEqual(['item-0', 'item-images', 'item-2']);
        expect(windowed.truncated).toBe(false);
        expect(windowed.items[1]).toEqual({ ...withImages, images: [{}, {}, {}] });
        expect(
            clipAgentChatPatchForMobile({
                terminalId: 'terminal-1',
                baseRevision: 7,
                revision: 8,
                operations: [{ op: 'upsertItem', item: withImages }],
            })?.operations,
        ).toEqual([{ op: 'upsertItem', item: { ...withImages, images: [{}, {}, {}] } }]);
    });

    it('returns a small Chat unchanged apart from its window', () => {
        const small = snapshot([message('item-1', 'hello')]);
        expect(windowAgentChatSnapshotForMobile(small)).toEqual(small);
    });

    it('lets the phone fold a clipped patch into its window with the shared reducer', () => {
        const windowed = windowAgentChatSnapshotForMobile(snapshot([message('item-1', 'Hi')]));
        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 7,
            revision: 8,
            operations: [{ op: 'appendText', itemId: 'item-1', delta: ' there' }],
        });
        expect(patch).toBeDefined();
        const next = applyAgentChatPatch(windowed, patch!);
        expect(next?.items[0]).toMatchObject({ text: 'Hi there' });
        expect(next?.revision).toBe(8);
    });

    it('keeps Desktop-only tasks and queue out of the phone projection', () => {
        const desktopOnly = {
            tasks: [
                {
                    id: 'task-1',
                    kind: 'agent' as const,
                    title: 'Explore',
                    status: 'running' as const,
                    isBackground: false,
                    canStop: false,
                },
            ],
            queue: [{ id: 'q-1', text: 'next' }],
            queuePaused: true,
        };
        const windowed = windowAgentChatSnapshotForMobile({
            ...snapshot([message('item-1', 'Hi')]),
            ...desktopOnly,
            operation: 'compacting',
        });
        expect(windowed).not.toHaveProperty('tasks');
        expect(windowed).not.toHaveProperty('queue');
        expect(windowed).not.toHaveProperty('queuePaused');
        expect(windowed.operation).toBe('compacting');
        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 7,
            revision: 8,
            operations: [{ op: 'state', state: { ...desktopOnly, status: 'ready' } }],
        });
        expect(patch?.operations).toEqual([{ op: 'state', state: { status: 'ready' } }]);
    });

    it('refuses a patch that cannot fit one frame', () => {
        expect(
            clipAgentChatPatchForMobile({
                terminalId: 'terminal-1',
                baseRevision: 0,
                revision: 1,
                operations: [{ op: 'appendText', itemId: 'item-1', delta: 'z'.repeat(60_000) }],
            }),
        ).toBeUndefined();
    });

    it('bounds a phone message to the mobile frame budget', () => {
        const parameters = mobileAgentChatMethods['mobile.agentChat.send'].params;
        expect(
            parameters.safeParse({ terminalId: 'terminal-1', text: 'Run the tests' }).success,
        ).toBe(true);
        expect(
            parameters.safeParse({ terminalId: 'terminal-1', text: 'x'.repeat(17_000) }).success,
        ).toBe(false);
    });
});
