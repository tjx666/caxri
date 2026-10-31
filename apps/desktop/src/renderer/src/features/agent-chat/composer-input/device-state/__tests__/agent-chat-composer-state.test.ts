import type { DeviceStoreBackend } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatAttachment } from '../../agent-chat-drafts';
import type { AgentChatComposerRestoration } from '../agent-chat-composer-state';
import { createAgentChatComposerState } from '../agent-chat-composer-state';
import { MAX_PERSISTED_AGENT_CHAT_DRAFTS } from '../agent-chat-composer-storage';

/**
 * An IndexedDB stand-in: every call answers on a later microtask, and the entries outlive the state objects built over
 * it, the way a database outlives the Renderer.
 */
function memoryBackend(entries = new Map<string, { modifiedAt: number; text: string }>()) {
    let clock = entries.size;
    const later = <T>(work: () => T): Promise<T> =>
        new Promise((resolve) => {
            queueMicrotask(() => resolve(work()));
        });
    const backend: DeviceStoreBackend = {
        clear: () => later(() => entries.clear()),
        list: () =>
            later(() =>
                [...entries].map(([name, { modifiedAt, text }]) => ({
                    modifiedAt,
                    name,
                    size: text.length,
                })),
            ),
        read: (name) => later(() => entries.get(name)?.text ?? null),
        remove: (name) =>
            later(() => {
                entries.delete(name);
            }),
        write: (name, text) =>
            later(() => {
                clock += 1;
                entries.set(name, { modifiedAt: clock, text });
            }),
    };
    return { backend, entries };
}

/**
 * The databases of one profile, by composer scope, shared by every window opened over it.
 */
function profile() {
    const databases = new Map<string, ReturnType<typeof memoryBackend>>();
    const database = (scope: string) => {
        let opened = databases.get(scope);
        if (!opened) {
            opened = memoryBackend();
            databases.set(scope, opened);
        }
        return opened;
    };
    /**
     * Opens a window: a fresh state over the profile's databases, whose scope the test moves with `scope.current`.
     */
    const openWindow = (initialScope = 'local') => {
        const scope = { current: initialScope };
        const restorations: AgentChatComposerRestoration[] = [];
        const state = createAgentChatComposerState({
            onRestored: (restoration) => restorations.push(restoration),
            openBackend: (name) => database(name).backend,
            scope: () => scope.current,
        });
        return { restorations, scope, state };
    };
    return { database, openWindow };
}

/**
 * Lets a window finish reading its stored state.
 */
async function ready(window: ReturnType<ReturnType<typeof profile>['openWindow']>) {
    window.state.isReady();
    await vi.advanceTimersByTimeAsync(10);
    expect(window.state.isReady()).toBe(true);
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
        await ready(first);
        first.state.drafts().set('chat-a', 'half written');
        first.state.saveDraft('chat-a', 'half written');
        first.state.edits().set('chat-a', edit);
        first.state.saveEdit('chat-a', edit);
        first.state.attachments().set('chat-a', [image]);
        first.state.saveAttachments('chat-a', [image]);
        first.state.retain(new Set(['chat-a']));
        // Nothing but the edit, which is written at once, reaches storage while the user is still typing.
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        await ready(restarted);
        expect(restarted.state.drafts().get('chat-a')).toBe('half written');
        expect(restarted.state.edits().get('chat-a')).toEqual(edit);
        expect(restarted.state.attachments().get('chat-a')).toEqual([image]);

        restarted.state.drafts().delete('chat-a');
        restarted.state.saveDraft('chat-a', '');
        restarted.state.attachments().delete('chat-a');
        restarted.state.saveAttachments('chat-a', []);
        await vi.advanceTimersByTimeAsync(300);

        const again = openWindow();
        await ready(again);
        expect(again.state.drafts().size).toBe(0);
        expect(again.state.attachments().size).toBe(0);
        expect(again.state.edits().get('chat-a')).toEqual(edit);
    });

    it('keeps each window scope to itself, and switches scope while running', async () => {
        const { openWindow } = profile();
        const local = openWindow('local');
        await ready(local);
        local.state.drafts().set('chat-a', 'local draft');
        local.state.saveDraft('chat-a', 'local draft');
        await vi.advanceTimersByTimeAsync(300);

        // The same window learns it belongs to an SSH Host: it reads and writes that scope from now on.
        local.scope.current = 'ssh:dev@203.0.113.7:22';
        expect(local.state.isReady()).toBe(false);
        await ready(local);
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
            // eslint-disable-next-line no-await-in-loop -- one window at a time keeps the scopes apart
            await ready(reopened);
            expect(reopened.state.drafts().keys().toArray()).toEqual(expected ? [expected] : []);
        }
    });

    it('writes a draft typed before the scope changed under the scope it was typed in', async () => {
        const { database, openWindow } = profile();
        const window = openWindow('local');
        await ready(window);
        window.state.drafts().set('chat-a', 'typed in local');
        window.state.saveDraft('chat-a', 'typed in local');
        window.scope.current = 'ssh:host';
        window.state.isReady();
        await vi.advanceTimersByTimeAsync(300);
        expect(database('local').entries.keys().toArray()).toEqual(['draft:chat-a']);
        expect(database('ssh:host').entries.size).toBe(0);
    });

    it('keeps the drafts two windows of one scope save for different Chats', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        const second = openWindow();
        await ready(first);
        await ready(second);
        first.state.drafts().set('chat-a', 'typed in the first window');
        first.state.saveDraft('chat-a', 'typed in the first window');
        second.state.drafts().set('chat-b', 'typed in the second window');
        second.state.saveDraft('chat-b', 'typed in the second window');
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        await ready(restarted);
        expect(restarted.state.drafts().get('chat-a')).toBe('typed in the first window');
        expect(restarted.state.drafts().get('chat-b')).toBe('typed in the second window');
    });

    it('keeps only the newest drafts within the bound', async () => {
        const { database, openWindow } = profile();
        const window = openWindow();
        await ready(window);
        for (let index = 0; index < MAX_PERSISTED_AGENT_CHAT_DRAFTS + 3; index += 1) {
            window.state.drafts().set(`chat-${index}`, 'x');
            window.state.saveDraft(`chat-${index}`, 'x');
            // eslint-disable-next-line no-await-in-loop -- each write must land before the next is scheduled
            await vi.advanceTimersByTimeAsync(300);
        }
        const names = database('local').entries.keys().toArray();
        expect(names).toHaveLength(MAX_PERSISTED_AGENT_CHAT_DRAFTS);
        expect(names).not.toContain('draft:chat-0');
        expect(names).toContain(`draft:chat-${MAX_PERSISTED_AGENT_CHAT_DRAFTS + 2}`);
    });

    it('releases the images and edit of a Chat that is gone, keeping open Chats and every draft', async () => {
        const { database, openWindow } = profile();
        const window = openWindow();
        await ready(window);
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
        expect(
            database('local')
                .entries.keys()
                .toArray()
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([
            'attachments:chat-open',
            'draft:chat-closed',
            'draft:chat-open',
            'edit:chat-open',
        ]);
    });

    it('deletes the stored images of a Chat the Workbench already reported gone, before they are read', async () => {
        const { database, openWindow } = profile();
        const first = openWindow();
        await ready(first);
        first.state.attachments().set('chat-gone', [image]);
        first.state.saveAttachments('chat-gone', [image]);
        first.state.attachments().set('chat-open', [image]);
        first.state.saveAttachments('chat-open', [image]);
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        // The Workbench snapshot arrives before the database has been read.
        restarted.state.retain(new Set(['chat-open']));
        await ready(restarted);
        await vi.advanceTimersByTimeAsync(300);
        expect(restarted.state.attachments().keys().toArray()).toEqual(['chat-open']);
        expect(database('local').entries.keys().toArray()).toEqual(['attachments:chat-open']);
    });

    it('keeps what this run changed before the stored state arrived', async () => {
        const { openWindow } = profile();
        const first = openWindow();
        await ready(first);
        first.state.drafts().set('chat-a', 'old draft');
        first.state.saveDraft('chat-a', 'old draft');
        first.state.attachments().set('chat-a', [image]);
        first.state.saveAttachments('chat-a', [image]);
        await vi.advanceTimersByTimeAsync(300);

        const restarted = openWindow();
        restarted.state.drafts().set('chat-a', 'new draft');
        restarted.state.attachments().set('chat-a', []);
        restarted.state.saveAttachments('chat-a', []);
        await ready(restarted);
        expect(restarted.state.drafts().get('chat-a')).toBe('new draft');
        expect(restarted.state.attachments().get('chat-a')).toEqual([]);
        expect(restarted.restorations.flatMap(({ draftTerminalIds }) => draftTerminalIds)).toEqual(
            [],
        );
    });
});
