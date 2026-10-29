import type { AgentChatItem, AgentChatSnapshot, EnvironmentState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatEditAvailability,
    agentChatEditCaption,
    agentChatEditRemovedTurns,
    agentChatForkAvailability,
    agentChatRestoreAvailability,
    MAX_PERSISTED_AGENT_CHAT_EDITS,
    parsePersistedAgentChatEdits,
    persistableAgentChatEdits,
} from '../agent-chat-edit';

type EditSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>;

function user(id: string, turnId: string, images?: Array<{ thumbnail?: string }>): AgentChatItem {
    return { id, type: 'userMessage', text: id, turnId, ...(images && { images }) };
}

const settled: EditSnapshot = {
    items: [user('u1', 't1'), user('u2', 't2', [{}]), user('u3', 't3')],
    turns: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
        { id: 't3', status: 'completed' },
    ],
};

describe('Agent Chat edit from here', () => {
    it('enables the action for a settled message and explains every refusal', () => {
        expect(agentChatEditAvailability(settled, 'u1')).toEqual({ canEdit: true });
        expect(agentChatEditAvailability(settled, 'u2')).toEqual({
            canEdit: false,
            reason: 'Messages with images cannot be edited',
        });
        expect(agentChatEditAvailability({ ...settled, activeTurnId: 't3' }, 'u1')).toEqual({
            canEdit: false,
            reason: 'Stop the running turn to edit from here',
        });
    });

    it('forks a message with images too, but not while a turn runs', () => {
        expect(agentChatForkAvailability(settled, 'u2')).toEqual({ canFork: true });
        expect(agentChatForkAvailability({ ...settled, activeTurnId: 't3' }, 'u1')).toEqual({
            canFork: false,
            reason: 'Stop the running turn to fork from here',
        });
        expect(agentChatForkAvailability(settled, 'missing')).toEqual({
            canFork: false,
            reason: 'The conversation cannot fork from this message',
        });
    });

    it('restores code to any settled message, images included, and explains a running turn', () => {
        expect(agentChatRestoreAvailability(settled, 'u1')).toEqual({ restoredTurns: 3 });
        expect(agentChatRestoreAvailability(settled, 'u2')).toEqual({ restoredTurns: 2 });
        expect(agentChatRestoreAvailability({ ...settled, activeTurnId: 't3' }, 'u3')).toEqual({
            reason: 'Stop the running turn to restore code',
        });
        expect(agentChatRestoreAvailability(settled, 'gone')).toEqual({
            reason: 'Code cannot be restored to this message',
        });
    });

    it('counts the turns an edit replaces, and ends an edit whose message is gone', () => {
        const edit = { itemId: 'u1', restoreFiles: false, previousDraft: '', appendedDraft: '' };
        expect(agentChatEditRemovedTurns(settled, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ ...settled, activeTurnId: 't3' }, edit)).toBe(3);
        expect(agentChatEditRemovedTurns({ items: [], turns: [] }, edit)).toBeUndefined();
        expect(agentChatEditCaption(1, translate)).toBe(
            'Editing an earlier message · its turn will be replaced',
        );
        expect(agentChatEditCaption(3, translate)).toBe(
            'Editing an earlier message · 3 turns will be replaced',
        );
    });
});

describe('Agent Chat edit persistence', () => {
    afterEach(() => vi.unstubAllGlobals());

    /**
     * Installs a `window` and `localStorage` under Vitest's `node` environment and loads a fresh copy of the module,
     * the way a restarted Renderer starts from storage alone.
     */
    async function restart(storage: Map<string, string>) {
        vi.stubGlobal('window', {});
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        vi.resetModules();
        return import('../agent-chat-edit');
    }

    it('brings an edit and its held-back draft back after a restart, and forgets one that ended', async () => {
        const storage = new Map<string, string>();
        const first = await restart(storage);
        first.writeAgentChatEdit('chat-a', {
            itemId: 'u1',
            restoreFiles: true,
            previousDraft: 'half written',
            appendedDraft: 'review comment',
        });
        first.writeAgentChatEdit('chat-b', {
            itemId: 'u2',
            restoreFiles: false,
            previousDraft: '',
            appendedDraft: '',
        });

        const restarted = await restart(storage);
        expect(restarted.readAgentChatEdit('chat-a')).toEqual({
            itemId: 'u1',
            restoreFiles: true,
            previousDraft: 'half written',
            appendedDraft: 'review comment',
        });
        restarted.writeAgentChatEdit('chat-a', undefined);

        const again = await restart(storage);
        expect(again.readAgentChatEdit('chat-a')).toBeUndefined();
        expect(again.readAgentChatEdit('chat-b')?.itemId).toBe('u2');
    });

    it('drops malformed entries instead of trusting them', () => {
        const parsed = parsePersistedAgentChatEdits([
            [
                'chat-a',
                { itemId: 'u1', restoreFiles: false, previousDraft: 'kept', appendedDraft: '' },
            ],
            ['chat-b', { itemId: '', restoreFiles: false, previousDraft: '', appendedDraft: '' }],
            ['chat-c', { itemId: 'u3', restoreFiles: 'yes', previousDraft: '', appendedDraft: '' }],
            ['chat-d', { itemId: 'u5', restoreFiles: false, previousDraft: '' }],
            ['', { itemId: 'u4', restoreFiles: false, previousDraft: '', appendedDraft: '' }],
            ['chat-e', null],
            'garbage',
        ]);
        expect(parsed.keys().toArray()).toEqual(['chat-a']);
        expect(parsePersistedAgentChatEdits(undefined).size).toBe(0);
    });

    /**
     * Opens one window over the shared `localStorage`: a fresh module graph, as a separate Renderer has, configured as
     * Caxri Bot or as a Workbench of `environment`.
     */
    async function openWindow(
        storage: Map<string, string>,
        window: { bot: true } | { environment: EnvironmentState },
    ) {
        const edits = await restart(storage);
        const persistence = await import('../../attachments/agent-chat-attachment-persistence');
        const { useEnvironmentStore } = await import('../../../../stores/environment');
        if ('bot' in window) persistence.configureAgentChatComposerWindowForBot();
        else useEnvironmentStore.setState({ state: window.environment });
        return edits;
    }

    const edit = { itemId: 'u1', restoreFiles: false, previousDraft: 'kept', appendedDraft: '' };
    const sshHost: EnvironmentState = {
        kind: 'ssh',
        destination: 'devbox',
        hostIdentity: 'dev@203.0.113.7:22',
        phase: 'connected',
        needsUserAction: false,
    };

    it("keeps Caxri Bot's edit when the Workbench retains its own Chats", async () => {
        const storage = new Map<string, string>();
        const bot = await openWindow(storage, { bot: true });
        bot.writeAgentChatEdit('bot-chat', edit);

        // The Workbench snapshot never includes Caxri Bot's Chat.
        const workbench = await openWindow(storage, { environment: { kind: 'local' } });
        workbench.retainAgentChatEdits(new Set(['workbench-chat']));

        const relaunched = await openWindow(storage, { bot: true });
        expect(relaunched.readAgentChatEdit('bot-chat')).toEqual(edit);
    });

    it("keeps a local Chat's edit when an SSH Host window retains its own Chats", async () => {
        const storage = new Map<string, string>();
        const local = await openWindow(storage, { environment: { kind: 'local' } });
        local.writeAgentChatEdit('local-chat', edit);

        const ssh = await openWindow(storage, { environment: sshHost });
        ssh.writeAgentChatEdit('ssh-chat', edit);
        ssh.retainAgentChatEdits(new Set(['ssh-chat']));

        const relaunched = await openWindow(storage, { environment: { kind: 'local' } });
        expect(relaunched.readAgentChatEdit('local-chat')).toEqual(edit);
        expect(relaunched.readAgentChatEdit('ssh-chat')).toBeUndefined();
    });

    it('keeps the edits two windows of one scope save for different Chats', async () => {
        const storage = new Map<string, string>();
        const first = await openWindow(storage, { environment: { kind: 'local' } });
        first.readAgentChatEdit('chat-a');
        const second = await openWindow(storage, { environment: { kind: 'local' } });
        second.readAgentChatEdit('chat-b');

        first.writeAgentChatEdit('chat-a', edit);
        second.writeAgentChatEdit('chat-b', { ...edit, itemId: 'u2' });

        const relaunched = await openWindow(storage, { environment: { kind: 'local' } });
        expect(relaunched.readAgentChatEdit('chat-a')).toEqual(edit);
        expect(relaunched.readAgentChatEdit('chat-b')?.itemId).toBe('u2');
    });

    it('keeps only the newest edits within the bound', () => {
        const edits = new Map(
            Array.from({ length: MAX_PERSISTED_AGENT_CHAT_EDITS + 2 }, (_, index) => [
                `chat-${index}`,
                { itemId: `u${index}`, restoreFiles: false, previousDraft: '', appendedDraft: '' },
            ]),
        );
        const kept = persistableAgentChatEdits(edits);
        expect(kept).toHaveLength(MAX_PERSISTED_AGENT_CHAT_EDITS);
        expect(kept[0]?.[0]).toBe('chat-2');
        expect(kept.at(-1)?.[0]).toBe(`chat-${MAX_PERSISTED_AGENT_CHAT_EDITS + 1}`);
    });
});
