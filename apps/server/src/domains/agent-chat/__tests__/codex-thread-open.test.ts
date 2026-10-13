import { describe, expect, it, vi } from 'vitest';

import type { CodexThreadSettings } from '../codex-chat-types';
import { openCodexThread } from '../codex-thread-open';
import type { JsonRpcConnection } from '../json-rpc-connection';

const settings: CodexThreadSettings = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    rootArgs: [],
};

/**
 * A connection whose `config/read` answers with `config` (or fails when it is an Error) and whose `thread/start`
 * returns a thread, recording every request.
 */
function connection(config: Record<string, unknown> | Error) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>((method) => {
        if (method === 'config/read')
            return config instanceof Error
                ? Promise.reject(config)
                : Promise.resolve({ config, origins: {} });
        return Promise.resolve({ thread: { id: 'thread-1' } });
    });
    return {
        request,
        close: vi.fn(() => Promise.resolve()),
        startParameters: () =>
            request.mock.calls.find(([method]) => method === 'thread/start')?.[1],
    } as unknown as JsonRpcConnection & {
        request: typeof request;
        startParameters: () => Record<string, unknown>;
    };
}

describe('openCodexThread instructions', () => {
    it("keeps the user's configured developer instructions ahead of Caxri's", async () => {
        const codex = connection({ developer_instructions: 'Answer in Chinese.' });
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters().developerInstructions).toBe(
            'Answer in Chinese.\n\nUse Caxri.',
        );
    });

    it('sends only Caxri instructions when the user configured none', async () => {
        const codex = connection({ developer_instructions: null });
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters().developerInstructions).toBe('Use Caxri.');
    });

    it("leaves the user's instructions in place when Codex cannot report them", async () => {
        const codex = connection(new Error('config/read unsupported'));
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters()).not.toHaveProperty('developerInstructions');
    });

    it('does not read the config when there is nothing to add', async () => {
        const codex = connection({ developer_instructions: 'Answer in Chinese.' });
        await openCodexThread(codex, { cwd: '/project', settings });

        expect(codex.request).not.toHaveBeenCalledWith(
            'config/read',
            expect.anything(),
            expect.anything(),
        );
        expect(codex.startParameters()).not.toHaveProperty('developerInstructions');
    });
});
