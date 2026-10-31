import type { DeviceStoreBackend } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatAttachment } from '../../agent-chat-drafts';
import { createAgentChatComposerState } from '../agent-chat-composer-state';
import type { SynchronousDeviceStoreBackend } from '../agent-chat-composer-storage';
import { MAX_PERSISTED_AGENT_CHAT_DRAFTS } from '../agent-chat-composer-storage';

type Entries = Map<string, { modifiedAt: number; text: string }>;

/**
 * A `localStorage` stand-in: every call finishes on the caller's tick, and the entries outlive the state objects built
 * over it, the way storage outlives the Renderer.
 */
const clock = { now: 0 };

function synchronousBackend(entries: Entries = new Map()): SynchronousDeviceStoreBackend {
    return {
        clear: () => entries.clear(),
        list: () =>
            [...entries].map(([name, { modifiedAt, text }]) => ({
                modifiedAt,
                name,
                size: text.length,
            })),
        read: (name) => entries.get(name)?.text ?? null,
        remove: (name) => {
            entries.delete(name);
        },
        write: (name, text) => {
            clock.now += 1;
            entries.set(name, { modifiedAt: clock.now, text });
        },
    };
}

/**
 * An IndexedDB stand-in: every call answers on a later microtask.
 */
function asynchronousBackend(entries: Entries = new Map()): DeviceStoreBackend {
    const later = <T>(work: () => T): Promise<T> =>
        new Promise((resolve) => {
            queueMicrotask(() => resolve(work()));
        });
    const inner = synchronousBackend(entries);
    return {
        clear: () => later(() => inner.clear()),
        list: () => later(() => inner.list()),
        read: (name) => later(() => inner.read(name)),
        remove: (name) => later(() => inner.remove(name)),
        write: (name, text) => later(() => inner.write(name, text)),
    };
}

/**
 * The storage of one profile, by composer scope, shared by every window opened over it.
 */
function profile() {
    const stored = new Map<string, { attachments: Entries; text: Entries }>();
    const entriesOf = (scope: string) => {
        let entries = stored.get(scope);
        if (!entries) {
            entries = { attachments: new Map(), text: new Map() };
            stored.set(scope, entries);
        }
        return entries;
    };
    /**
     * Every entry name stored under `scope`, sorted.
     */
    const storedNames = (scope: string): string[] => {
        const { attachments, text } = entriesOf(scope);
        return [...text.keys(), ...attachments.keys()].toSorted((left, right) =>
            left.localeCompare(right),
        );
    };
    /**
     * Opens a window: a fresh state over the profile's storage, whose scope the test moves with `scope.current`.
     */
    const openWindow = (initialScope = 'local') => {
        const scope = { current: initialScope };
        const restoredAttachments: Array<ReadonlyMap<string, AgentChatAttachment[]>> = [];
        const restoredDrafts: string[][] = [];
        const state = createAgentChatComposerState({
            onAttachmentsRestored: (attachments) => restoredAttachments.push(attachments),
            onDraftsRestored: (terminalIds) => restoredDrafts.push([...terminalIds]),
            openBackends: (name) => ({
                attachments: asynchronousBackend(entriesOf(name).attachments),
                text: synchronousBackend(entriesOf(name).text),
            }),
            scope: () => scope.current,
        });
        return { restoredAttachments, restoredDrafts, scope, state };
    };
    return { openWindow, storedNames };
}

/**
 * Lets a window finish reading its stored images.
 */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(10);
}

const image: AgentChatAttachment = {
    id: 'image-1',
    image: { mediaType: 'image/png', data: 'AAAA', thumbnail: 'data:image/jpeg;base64,AAAA' },
    name: 'shot.png',
};
const edit = { itemId: 'u1', restoreFiles: true, previousDraft: 'set aside', appendedDraft: '' };

describe('Agent Chat composer state', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('restores drafts, edits, and images after a restart, and forgets what a send cleared', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        first.state.drafts().set('chat-a', 'half written');
        first.state.saveDraft('chat-a', 'half written');
        first.state.edits().set('chat-a', edit);
        first.state.saveEdit('chat-a', edit);
        first.state.attachments().set('chat-a', [image]);
        first.state.saveAttachments('chat-a', [image]);
        first.state.retain(new Set(['chat-a']));
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        expect(restarted.state.drafts().get('chat-a')).toBe('half written');
        expect(restarted.state.edits().get('chat-a')).toEqual(edit);
        await settle();
        expect(restarted.state.attachments().get('chat-a')).toEqual([image]);
        expect(restarted.restoredAttachments).toEqual([new Map([['chat-a', [image]]])]);

        restarted.state.drafts().delete('chat-a');
        restarted.state.saveDraft('chat-a', '');
        restarted.state.attachments().delete('chat-a');
        restarted.state.saveAttachments('chat-a', []);
        await vi.advanceTimersByTimeAsync(300);

        const again = openWindow();
        await settle();
        expect(again.state.drafts().size).toBe(0);
        expect(again.state.attachments().size).toBe(0);
        expect(again.state.edits().get('chat-a')).toEqual(edit);
    });

    it('stores the draft typed just before the window goes away, and reads it on the first paint after', () => {
        const { openWindow } = profile();
        const first = openWindow();
        first.state.drafts().set('chat-a', 'typed right before the reload');
        first.state.saveDraft('chat-a', 'typed right before the reload');
        // `pagehide`: no timer gets to fire, and nothing after the flush is awaited.
        first.state.flush();

        const reloaded = openWindow();
        expect(reloaded.state.drafts().get('chat-a')).toBe('typed right before the reload');
    });

    it('is ready once the stored images are read, and again for each new scope', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        first.state.attachments().set('chat-a', [image]);
        first.state.saveAttachments('chat-a', [image]);
        await settle();

        const reloaded = openWindow();
        const readiness: boolean[] = [];
        reloaded.state.subscribeReady(() => readiness.push(reloaded.state.isReady()));
        expect(reloaded.state.isReady()).toBe(false);
        await settle();
        expect(reloaded.state.isReady()).toBe(true);
        expect(reloaded.state.attachments().get('chat-a')).toEqual([image]);
        expect(readiness.at(-1)).toBe(true);

        reloaded.scope.current = 'ssh:host';
        expect(reloaded.state.isReady()).toBe(false);
        await settle();
        expect(reloaded.state.isReady()).toBe(true);
    });

    it('stores pasted images without waiting for typing to pause', async () => {
        const { openWindow, storedNames } = profile();
        const window = openWindow();
        window.state.attachments().set('chat-a', [image]);
        window.state.saveAttachments('chat-a', [image]);
        await vi.advanceTimersByTimeAsync(1);
        expect(storedNames('local')).toEqual(['attachments:chat-a']);
    });

    it('keeps each window scope to itself, and switches scope while running', async () => {
        const { openWindow } = profile();
        const local = openWindow('local');
        local.state.drafts().set('chat-a', 'local draft');
        local.state.saveDraft('chat-a', 'local draft');
        await vi.advanceTimersByTimeAsync(300);

        // The same window learns it belongs to an SSH Host: it reads and writes that scope from now on.
        local.scope.current = 'ssh:dev@203.0.113.7:22';
        expect(local.state.drafts().size).toBe(0);
        local.state.drafts().set('chat-b', 'ssh draft');
        local.state.saveDraft('chat-b', 'ssh draft');
        await vi.advanceTimersByTimeAsync(300);

        for (const [scope, expected] of [
            ['local', 'chat-a'],
            ['ssh:dev@203.0.113.7:22', 'chat-b'],
            ['bot', undefined],
        ] as const) {
            const reopened = openWindow(scope);
            expect(reopened.state.drafts().keys().toArray()).toEqual(expected ? [expected] : []);
        }
    });

    it('tells the surfaces that render from a draft which drafts a scope restored', async () => {
        const { openWindow } = profile();
        const first = openWindow('ssh:host');
        first.state.drafts().set('chat-a', 'ssh draft');
        first.state.saveDraft('chat-a', 'ssh draft');
        first.state.flush();

        const window = openWindow('local');
        window.state.drafts();
        window.scope.current = 'ssh:host';
        window.state.drafts();
        expect(window.restoredDrafts).toEqual([]);
        await Promise.resolve();
        expect(window.restoredDrafts).toEqual([['chat-a']]);
    });

    it('writes a draft typed before the scope changed under the scope it was typed in', async () => {
        const { openWindow, storedNames } = profile();
        const window = openWindow('local');
        window.state.drafts().set('chat-a', 'typed in local');
        window.state.saveDraft('chat-a', 'typed in local');
        window.scope.current = 'ssh:host';
        window.state.drafts();
        await vi.advanceTimersByTimeAsync(300);
        expect(storedNames('local')).toEqual(['draft:chat-a']);
        expect(storedNames('ssh:host')).toEqual([]);
    });

    it('keeps the drafts two windows of one scope save for different Chats', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        const second = openWindow();
        first.state.drafts().set('chat-a', 'typed in the first window');
        first.state.saveDraft('chat-a', 'typed in the first window');
        second.state.drafts().set('chat-b', 'typed in the second window');
        second.state.saveDraft('chat-b', 'typed in the second window');
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        expect(restarted.state.drafts().get('chat-a')).toBe('typed in the first window');
        expect(restarted.state.drafts().get('chat-b')).toBe('typed in the second window');
    });

    it('keeps only the newest drafts within the bound', async () => {
        const { openWindow, storedNames } = profile();
        const window = openWindow();
        for (let index = 0; index < MAX_PERSISTED_AGENT_CHAT_DRAFTS + 3; index += 1) {
            window.state.drafts().set(`chat-${index}`, 'x');
            window.state.saveDraft(`chat-${index}`, 'x');
            // eslint-disable-next-line no-await-in-loop -- each write must land before the next is scheduled
            await vi.advanceTimersByTimeAsync(300);
        }
        const names = storedNames('local');
        expect(names).toHaveLength(MAX_PERSISTED_AGENT_CHAT_DRAFTS);
        expect(names).not.toContain('draft:chat-0');
        expect(names).toContain(`draft:chat-${MAX_PERSISTED_AGENT_CHAT_DRAFTS + 2}`);
    });

    it('releases the images and edit of a Chat that is gone, keeping open Chats and every draft', async () => {
        const { openWindow, storedNames } = profile();
        const window = openWindow();
        for (const terminalId of ['chat-open', 'chat-closed']) {
            window.state.drafts().set(terminalId, `draft of ${terminalId}`);
            window.state.saveDraft(terminalId, `draft of ${terminalId}`);
            window.state.attachments().set(terminalId, [image]);
            window.state.saveAttachments(terminalId, [image]);
            window.state.edits().set(terminalId, edit);
            window.state.saveEdit(terminalId, edit);
        }
        await vi.advanceTimersByTimeAsync(300);

        window.state.retain(new Set(['chat-open']));
        await vi.advanceTimersByTimeAsync(300);

        expect(window.state.attachments().has('chat-closed')).toBe(false);
        expect(window.state.edits().has('chat-closed')).toBe(false);
        expect(window.state.drafts().get('chat-closed')).toBe('draft of chat-closed');
        expect(storedNames('local')).toEqual([
            'attachments:chat-open',
            'draft:chat-closed',
            'draft:chat-open',
            'edit:chat-open',
        ]);
    });

    it('deletes the stored images and edit of a Chat the Workbench already reported gone, before they are read', async () => {
        const { openWindow, storedNames } = profile();
        const first = openWindow();
        for (const terminalId of ['chat-gone', 'chat-open']) {
            first.state.attachments().set(terminalId, [image]);
            first.state.saveAttachments(terminalId, [image]);
            first.state.edits().set(terminalId, edit);
            first.state.saveEdit(terminalId, edit);
        }
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        // The Workbench snapshot arrives before the images have been read.
        restarted.state.retain(new Set(['chat-open']));
        await vi.advanceTimersByTimeAsync(300);
        expect(restarted.state.attachments().keys().toArray()).toEqual(['chat-open']);
        expect(restarted.state.edits().keys().toArray()).toEqual(['chat-open']);
        expect(storedNames('local')).toEqual(['attachments:chat-open', 'edit:chat-open']);
    });

    it('keeps the images this run changed before the stored ones arrived', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        first.state.attachments().set('chat-a', [image]);
        first.state.saveAttachments('chat-a', [image]);
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        restarted.state.attachments().set('chat-a', []);
        restarted.state.saveAttachments('chat-a', []);
        await settle();
        expect(restarted.state.attachments().get('chat-a')).toEqual([]);
        expect(restarted.restoredAttachments).toEqual([new Map()]);
    });
});
