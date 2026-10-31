import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEnvironmentStore } from '../../../../../stores/environment';
import {
    agentChatComposerDatabaseName,
    agentChatComposerScope,
    currentAgentChatComposerScope,
} from '../agent-chat-composer-scope';

describe('agentChatComposerScope', () => {
    const ssh = (destination: string, hostIdentity = destination) => ({
        destination,
        hostIdentity,
        kind: 'ssh' as const,
        needsUserAction: false,
        phase: 'connected' as const,
    });
    const database = (...parameters: Parameters<typeof agentChatComposerScope>) =>
        agentChatComposerDatabaseName(agentChatComposerScope(...parameters));

    it('gives each SSH Host and Caxri Bot its own database so windows never prune each other', () => {
        const local = database('workbench', { kind: 'local' });
        const bot = database('bot', undefined);
        const devbox = database('workbench', ssh('devbox'));
        expect(database('workbench', undefined)).toBe(local);
        expect(devbox).not.toBe(local);
        expect(devbox).not.toBe(database('workbench', ssh('buildbox')));
        expect(new Set([local, bot, devbox]).size).toBe(3);
    });

    it("keys an SSH Host by Main's resolved host key, so every alias finds the same unsent state", () => {
        const resolved = 'dev@203.0.113.7:22';
        expect(agentChatComposerScope('workbench', ssh('work', resolved))).toBe(
            agentChatComposerScope('workbench', ssh('work-direct', resolved)),
        );
        expect(database('workbench', ssh('work', resolved))).toBe(
            database('workbench', ssh('work-direct', resolved)),
        );
    });
});

describe('currentAgentChatComposerScope', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        useEnvironmentStore.setState({ state: undefined });
    });

    it('deletes the composer state stored before the device store held it, once', () => {
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
        useEnvironmentStore.setState({
            state: {
                kind: 'ssh',
                destination: 'devbox',
                hostIdentity: 'dev@devbox.example:22',
                phase: 'connected',
                needsUserAction: false,
            },
        });

        expect(currentAgentChatComposerScope()).toBe('ssh:dev@devbox.example:22');
        currentAgentChatComposerScope();

        expect(Object.keys(storage).filter((key) => key.startsWith('caxri.'))).toEqual([
            'caxri.other',
        ]);
        expect(deleteDatabase.mock.calls).toEqual([
            ['caxri-agent-chat:ssh:dev@devbox.example:22'],
            ['caxri-agent-chat:ssh:devbox'],
        ]);
    });
});
