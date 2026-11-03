import type { TerminalRecord } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    forgetEnvironment,
    indexEnvironmentSnapshot,
} from '../../../../../lib/environment-routing';
import {
    agentChatComposerDatabaseName,
    agentChatComposerScope,
    currentAgentChatComposerScope,
} from '../agent-chat-composer-scope';

describe('agentChatComposerScope', () => {
    const database = (...parameters: Parameters<typeof agentChatComposerScope>) =>
        agentChatComposerDatabaseName(agentChatComposerScope(...parameters));

    it('gives each SSH Host and Caxri Bot its own database so machines never prune each other', () => {
        const local = database('workbench', undefined);
        const bot = database('bot', 'dev@203.0.113.7:22');
        const devbox = database('workbench', 'dev@203.0.113.7:22');
        expect(devbox).not.toBe(local);
        expect(devbox).not.toBe(database('workbench', 'dev@203.0.113.8:22'));
        expect(new Set([local, bot, devbox]).size).toBe(3);
    });
});

describe('currentAgentChatComposerScope', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        forgetEnvironment('dev@devbox.example:22');
    });

    it('keys a Chat by the machine running it and deletes the superseded composer state once', () => {
        const storage: Record<string, unknown> = {
            'caxri.agent-chat.drafts': '[]',
            'caxri.agent-chat.drafts:local': '[]',
            'caxri.agent-chat.edits:bot': '[]',
            'caxri.other': 'kept',
            'removeItem': function (key: string) {
                delete storage[key];
            },
        };
        const deleteDatabase = vi.fn();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('indexedDB', { deleteDatabase });
        indexEnvironmentSnapshot(
            'dev@devbox.example:22',
            {
                projects: [],
                sessions: [],
                terminals: [{ id: 'remote-chat' } as TerminalRecord],
                archivedTerminals: [],
            },
            0,
        );

        expect(currentAgentChatComposerScope('remote-chat')).toBe('ssh:dev@devbox.example:22');
        currentAgentChatComposerScope('remote-chat');
        expect(currentAgentChatComposerScope('local-chat')).toBe('local');

        expect(Object.keys(storage).filter((key) => key.startsWith('caxri.'))).toEqual([
            'caxri.other',
        ]);
        expect(deleteDatabase.mock.calls).toEqual([
            ['caxri-agent-chat:ssh:dev@devbox.example:22'],
            ['caxri-agent-chat'],
        ]);
    });
});
