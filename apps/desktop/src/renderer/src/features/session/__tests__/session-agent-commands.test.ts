import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToastKind, ToastOptions } from '../../../stores/toasts';

const mocks = vi.hoisted(() => {
    const pushToast = vi.fn<(kind: ToastKind, message: string, options?: ToastOptions) => void>();
    return {
        caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve([])),
        copyFilePath: vi.fn(() => Promise.resolve()),
        getBootstrap: vi.fn(),
        pushToast,
        refreshWorkbench: vi.fn(() => Promise.resolve()),
        /**
         * Mirrors the real funnel's swallow-and-report contract rather than only forwarding `run`: an action offered
         * inside a toast must survive its own request failing, which is unobservable when the double re-throws.
         */
        tryCommand: vi.fn(
            async (
                ...[label, run]: [
                    string,
                    () => Promise<unknown>,
                    { refresh?: () => Promise<void> }?,
                ]
            ): Promise<unknown> => {
                try {
                    return await run();
                } catch (error) {
                    pushToast('error', `${label}: ${(error as Error).message}`);
                    return undefined;
                }
            },
        ),
        writeText: vi.fn(() => Promise.resolve()),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../lib/copy-file-path', () => ({ copyFilePath: mocks.copyFilePath }));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: vi.fn(),
}));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/workbench', () => ({
    refreshWorkbench: mocks.refreshWorkbench,
    useWorkbenchStore: { getState: () => ({ bootstrap: undefined }) },
}));

import {
    chatConversationBlocker,
    copyAgentSessionId,
    copyAgentTranscriptPath,
    detachSession,
    detachTurnTerminalId,
    sessionForkBlocker,
} from '../session-agent-commands';

vi.mock('../../../lib/clipboard', () => ({
    textClipboard: { writeText: mocks.writeText },
    writeClipboardText: mocks.writeText,
}));

describe('Agent identifier copy', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.copyFilePath.mockClear();
        mocks.pushToast.mockClear();
        mocks.tryCommand.mockClear();
        mocks.writeText.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('copies the Agent conversation id rather than the Caxri Session row id', async () => {
        copyAgentSessionId('01a08fbe-2b76-7ae2-8c0e-8a11262ac36d');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.writeText).toHaveBeenCalledWith('01a08fbe-2b76-7ae2-8c0e-8a11262ac36d');
        expect(mocks.pushToast).toHaveBeenCalledWith('success', 'Conversation ID copied');
    });

    it('asks the Runtime for the transcript path without reading the transcript', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({
            path: '/Users/me/.codex/sessions/2026/09/11/rollout-01a08fbe.jsonl',
            exists: true,
            truncated: false,
        });

        copyAgentTranscriptPath('terminal-1');
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.agentTranscript', {
            terminalId: 'terminal-1',
            withContent: false,
        });
        expect(mocks.copyFilePath).toHaveBeenCalledWith(
            '/Users/me/.codex/sessions/2026/09/11/rollout-01a08fbe.jsonl',
        );
    });

    it('copies nothing when the Agent keeps no on-disk transcript', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(null);

        copyAgentTranscriptPath('terminal-1');
        // `tryCommand` swallows the throw and reports it, so the user-visible evidence is the toast rather than a
        // rejected promise: the caller discards the promise on purpose and would otherwise surface nothing.
        await mocks.tryCommand.mock.results[0]?.value;

        expect(mocks.pushToast).toHaveBeenCalledWith(
            'error',
            'Unable to copy the transcript path: This Agent keeps no on-disk transcript',
        );
        expect(mocks.copyFilePath).not.toHaveBeenCalled();
    });
});

describe('detachTurnTerminalId', () => {
    const session = { id: 'session-1', primaryAgentTerminalId: 'primary' };

    it('checks the live Primary Agent first, since only its turn is tracked', () => {
        expect(
            detachTurnTerminalId(session, [
                {
                    id: 'secondary',
                    sessionId: 'session-1',
                    provider: 'codex',
                    lastProcessState: 'running',
                },
                {
                    id: 'primary',
                    sessionId: 'session-1',
                    provider: 'claude',
                    lastProcessState: 'running',
                },
            ]),
        ).toBe('primary');
    });

    it('falls back to another live Agent, and ignores Shells, exited Agents, and other Sessions', () => {
        expect(
            detachTurnTerminalId(session, [
                {
                    id: 'primary',
                    sessionId: 'session-1',
                    provider: 'claude',
                    lastProcessState: 'stopped',
                },
                {
                    id: 'shell',
                    sessionId: 'session-1',
                    provider: undefined,
                    lastProcessState: 'running',
                },
                {
                    id: 'other',
                    sessionId: 'session-2',
                    provider: 'codex',
                    lastProcessState: 'running',
                },
                {
                    id: 'secondary',
                    sessionId: 'session-1',
                    provider: 'codex',
                    lastProcessState: 'starting',
                },
            ]),
        ).toBe('secondary');
        expect(detachTurnTerminalId(session, [])).toBeUndefined();
    });
});

describe('detachSession', () => {
    beforeEach(() => {
        mocks.caxriRequest.mockClear();
        mocks.getBootstrap.mockReset();
    });

    it('detaches an idle Agent at once, without asking', async () => {
        mocks.getBootstrap.mockReturnValue({
            sessions: [
                {
                    id: 'session-1',
                    primaryAgentTerminalId: 'terminal-1',
                    agentActivityState: 'idle',
                },
            ],
            terminals: [
                {
                    id: 'terminal-1',
                    sessionId: 'session-1',
                    provider: 'claude',
                    lastProcessState: 'running',
                    lastAgentProcessState: 'running',
                },
            ],
        });

        detachSession('session-1');

        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('session.detach', {
                sessionId: 'session-1',
            }),
        );
    });
});

describe('sessionForkBlocker', () => {
    it('offers Fork Session for a Chat Agent with a conversation', () => {
        expect(
            sessionForkBlocker({ provider: 'codex', surface: 'chat', agentSessionId: 'thread-1' }),
        ).toBeUndefined();
    });

    it('says why a Session without a Chat conversation cannot fork', () => {
        expect(sessionForkBlocker(undefined)).toBe('noAgent');
        expect(sessionForkBlocker({ provider: undefined, agentSessionId: undefined })).toBe(
            'noAgent',
        );
        expect(sessionForkBlocker({ provider: 'claude', agentSessionId: 'session-1' })).toBe(
            'notChat',
        );
        expect(
            sessionForkBlocker({ provider: 'grok', surface: 'chat', agentSessionId: undefined }),
        ).toBe('noConversation');
    });

    it('says an Agent that cannot fork its conversation is unsupported, though it can still continue elsewhere', () => {
        const terminal = {
            provider: 'antigravity',
            surface: 'chat',
            agentSessionId: 'c-1',
        } as const;
        expect(sessionForkBlocker(terminal)).toBe('unsupported');
        expect(chatConversationBlocker(terminal)).toBeUndefined();
    });
});
