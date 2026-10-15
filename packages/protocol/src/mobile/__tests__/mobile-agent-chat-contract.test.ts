import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatSnapshot } from '../../agent/agent-chat-contract.js';
import {
    agentChatPatchSchema,
    agentChatSnapshotSchema,
    MAX_AGENT_CHAT_IMAGES,
} from '../../agent/agent-chat-contract.js';
import { applyAgentChatPatch } from '../../agent/agent-chat-reducer.js';
import {
    clipAgentChatCommandsForMobile,
    clipAgentChatItemForMobile,
    clipAgentChatPatchForMobile,
    clipAgentChatQueueForMobile,
    MOBILE_AGENT_CHAT_CLIP_MARKER,
    MOBILE_AGENT_CHAT_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
    MOBILE_AGENT_CHAT_COMMAND_DESCRIPTION_MAX_LENGTH,
    MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH,
    MOBILE_AGENT_CHAT_MAX_BYTES,
    MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS,
    MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH,
    mobileAgentChatMethods,
    mobileDashboardSessionSchema,
    windowAgentChatSnapshotForMobile,
} from '../mobile-contract.js';
import { mobileImageReadInternalParametersSchema } from '../mobile-image-contract.js';

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

    it('names changed files Project-relative in the window and in patches, as Desktop does', () => {
        const change: AgentChatItem = {
            id: 'change-1',
            turnId: 'turn-1',
            type: 'fileChange',
            status: 'completed',
            changes: [
                { path: '/work/demo/src/greeting.ts', kind: 'update', diff: '' },
                { path: '/elsewhere/notes.md', kind: 'add', diff: '' },
            ],
        };
        const paths = (item: AgentChatItem | undefined) =>
            item?.type === 'fileChange' ? item.changes.map((entry) => entry.path) : [];
        const expected = ['src/greeting.ts', '/elsewhere/notes.md'];
        const windowed = windowAgentChatSnapshotForMobile(snapshot([change]), '/work/demo');
        expect(paths(windowed.items[0])).toEqual(expected);
        const patch = clipAgentChatPatchForMobile(
            {
                terminalId: 'terminal-1',
                baseRevision: 7,
                revision: 8,
                operations: [{ op: 'upsertItem', item: change }],
            },
            '/work/demo',
        );
        const operation = patch?.operations[0];
        expect(paths(operation?.op === 'upsertItem' ? operation.item : undefined)).toEqual(
            expected,
        );
    });

    it('sends the background tasks and the queue to the phone', () => {
        const desktopState = {
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
            ...desktopState,
            operation: 'compacting',
        });
        expect(windowed.tasks).toEqual(desktopState.tasks);
        expect(windowed.queue).toEqual([{ id: 'q-1', text: 'next' }]);
        expect(windowed.queuePaused).toBe(true);
        expect(windowed.operation).toBe('compacting');
        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 7,
            revision: 8,
            operations: [{ op: 'state', state: { ...desktopState, status: 'ready' } }],
        });
        expect(patch?.operations).toEqual([
            {
                op: 'state',
                state: {
                    tasks: desktopState.tasks,
                    queue: [{ id: 'q-1', text: 'next' }],
                    queueLength: 1,
                    queuePaused: true,
                    status: 'ready',
                },
            },
        ]);
    });

    it('bounds the queue a phone receives to a few previews', () => {
        const long = 'x'.repeat(50_000);
        const queue = Array.from({ length: 20 }, (_, index) => ({
            id: `q-${index}`,
            text: long,
            imageCount: 2,
        }));
        const clipped = clipAgentChatQueueForMobile([
            { id: 'cmd', text: '', command: { name: 'review', arguments: long } },
            ...queue,
        ]);
        expect(clipped).toHaveLength(MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS);
        expect(clipped[0].command?.arguments).toBe(
            `${'x'.repeat(MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH)}${MOBILE_AGENT_CHAT_CLIP_MARKER}`,
        );
        expect(clipped[1]).toEqual({
            id: 'q-0',
            text: `${'x'.repeat(MOBILE_AGENT_CHAT_QUEUE_PREVIEW_LENGTH)}${MOBILE_AGENT_CHAT_CLIP_MARKER}`,
            imageCount: 2,
        });
        const windowed = windowAgentChatSnapshotForMobile({
            ...snapshot([message('item-1', 'Hi')]),
            queue,
        });
        expect(windowed.queue).toHaveLength(MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS);
        expect(windowed.queueLength).toBe(20);
        expect(bytes(windowed)).toBeLessThan(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(agentChatSnapshotSchema.safeParse(windowed).success).toBe(true);
        expect(clipAgentChatQueueForMobile([{ id: 'short', text: 'hi' }])).toEqual([
            { id: 'short', text: 'hi' },
        ]);
    });

    it('tells the phone the real length of a queue its preview cuts short', () => {
        const queue = Array.from({ length: 20 }, (_, index) => ({
            id: `q-${index}`,
            text: 'next',
        }));
        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 7,
            revision: 8,
            operations: [{ op: 'state', state: { queue } }],
        });
        const operation = patch?.operations[0];
        const state = operation?.op === 'state' ? operation.state : undefined;
        expect(state?.queue).toHaveLength(MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS);
        expect(state?.queueLength).toBe(20);
        expect(agentChatPatchSchema.safeParse(patch).success).toBe(true);
        expect(patch && applyAgentChatPatch(snapshot([]), patch)?.queueLength).toBe(20);
    });

    it('shortens command descriptions and hints but keeps every command name', () => {
        const commands = Array.from({ length: 200 }, (_, index) => ({
            name: `skill-${index}`,
            description: 'd'.repeat(500),
            argumentHint: 'a'.repeat(200),
        }));
        const clipped = clipAgentChatCommandsForMobile([...commands, { name: 'review' }]);
        expect(clipped).toHaveLength(201);
        expect(clipped[0]?.description).toHaveLength(
            MOBILE_AGENT_CHAT_COMMAND_DESCRIPTION_MAX_LENGTH,
        );
        expect(clipped[0]?.description?.endsWith(MOBILE_AGENT_CHAT_CLIP_MARKER)).toBe(true);
        expect(clipped[0]?.argumentHint).toHaveLength(
            MOBILE_AGENT_CHAT_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
        );
        expect(clipped.at(-1)).toEqual({ name: 'review' });
        expect(
            clipAgentChatCommandsForMobile([{ name: 'compact', description: 'Compact' }]),
        ).toEqual([{ name: 'compact', description: 'Compact' }]);

        const windowed = windowAgentChatSnapshotForMobile({
            ...snapshot([message('m-1', 'hello')]),
            commands,
        });
        expect(windowed.commands).toEqual(clipAgentChatCommandsForMobile(commands));
        expect(windowed.items).toHaveLength(1);

        const patch = clipAgentChatPatchForMobile({
            terminalId: 'terminal-1',
            baseRevision: 7,
            revision: 8,
            operations: [{ op: 'state', state: { commands } }],
        });
        const operation = patch?.operations[0];
        expect(operation?.op === 'state' ? operation.state.commands : undefined).toEqual(
            clipAgentChatCommandsForMobile(commands),
        );
        expect(agentChatPatchSchema.safeParse(patch).success).toBe(true);
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

    it('reads every image and thumbnail of a message with the most images', () => {
        const id = (index: number) => `image_${index.toString(16).padStart(32, '0')}`;
        const attachments = Array.from({ length: MAX_AGENT_CHAT_IMAGES }, (_, index) => ({
            attachmentId: id(index * 2),
            thumbnailAttachmentId: id(index * 2 + 1),
        }));
        expect(
            mobileAgentChatMethods['mobile.agentChat.send'].params.safeParse({
                terminalId: 'terminal-1',
                text: '',
                attachments,
            }).success,
        ).toBe(true);
        const read = (count: number) =>
            mobileImageReadInternalParametersSchema.safeParse({
                sessionId: 'session-1',
                attachmentIds: Array.from({ length: count }, (_, index) => id(index)),
                principal: { kind: 'human-cli', id: 'owner' },
            });
        expect(read(MAX_AGENT_CHAT_IMAGES * 2).error).toBeUndefined();
        expect(read(MAX_AGENT_CHAT_IMAGES * 2 + 1).success).toBe(false);
    });

    it('runs a slash command with arguments a phone may send', () => {
        const parameters = mobileAgentChatMethods['mobile.agentChat.runCommand'].params;
        expect(parameters.safeParse({ terminalId: 'terminal-1', name: 'compact' }).success).toBe(
            true,
        );
        expect(
            parameters.safeParse({
                terminalId: 'terminal-1',
                name: 'compact',
                arguments: 'keep it',
            }).success,
        ).toBe(true);
        expect(
            parameters.safeParse({
                terminalId: 'terminal-1',
                name: 'compact',
                arguments: 'x'.repeat(17_000),
            }).success,
        ).toBe(false);
        expect(parameters.safeParse({ terminalId: 'terminal-1', name: 'rm -rf' }).success).toBe(
            false,
        );
    });

    it('returns a taken queued message only when the phone could send it again', () => {
        const result = mobileAgentChatMethods['mobile.agentChat.takeQueued'].result;
        expect(result.safeParse({ text: 'x'.repeat(5_000) }).success).toBe(true);
        expect(result.safeParse({ text: 'x'.repeat(17_000) }).success).toBe(false);
    });
});
