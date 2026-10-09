import { describe, expect, it, vi } from 'vitest';

import type { PullRequestMergeNoticeOptions } from '../pull-request-merge-notice';
import { createPullRequestMergeNotice, formatMergeNotice } from '../pull-request-merge-notice';

const URL = 'https://github.com/acme/widget/pull/42';

function harness(overrides: {
    enabled?: boolean;
    launchId?: string;
    session?: { primaryAgentTerminalId?: string | null } | undefined;
    terminal?: Record<string, unknown> | undefined;
    submit?: 'accepted' | 'rejected' | 'unknown';
}) {
    const submitAgentExact = vi.fn(() => Promise.resolve(overrides.submit ?? 'accepted'));
    const send = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const session =
        'session' in overrides ? overrides.session : { primaryAgentTerminalId: 'terminal-1' };
    const terminal =
        'terminal' in overrides
            ? overrides.terminal
            : { id: 'terminal-1', sessionId: 'session-1', provider: 'claude' };
    const options = {
        agentChat: { send },
        database: {
            getSession: () => session,
            getTerminal: () => terminal,
        },
        isEnabled: () => overrides.enabled ?? true,
        logger: { write },
        terminals: {
            agentLaunchId: () => ('launchId' in overrides ? overrides.launchId : 'launch-1'),
            submitAgentExact,
        },
    } as unknown as PullRequestMergeNoticeOptions;
    return { notice: createPullRequestMergeNotice(options), send, submitAgentExact, write };
}

describe('createPullRequestMergeNotice', () => {
    it("submits the merged link to the Session's primary PTY Agent, pinned to its launch", async () => {
        const { notice, submitAgentExact, write } = harness({});

        await expect(notice('session-1', URL)).resolves.toBe('sent');

        expect(submitAgentExact).toHaveBeenCalledWith(
            'terminal-1',
            'session-1',
            'launch-1',
            formatMergeNotice(URL),
        );
        expect(formatMergeNotice(URL)).toContain(URL);
        expect(write).toHaveBeenCalledWith(
            'info',
            expect.any(String),
            expect.objectContaining({ fields: { outcome: 'sent' } }),
        );
    });

    it('sends a Chat Agent an ordinary turn', async () => {
        const { notice, send, submitAgentExact } = harness({
            terminal: {
                id: 'terminal-1',
                sessionId: 'session-1',
                provider: 'codex',
                surface: 'chat',
            },
        });

        await expect(notice('session-1', URL)).resolves.toBe('sent');

        expect(send).toHaveBeenCalledWith('terminal-1', { text: formatMergeNotice(URL) });
        expect(submitAgentExact).not.toHaveBeenCalled();
    });

    it('does nothing and logs nothing while the setting is off', async () => {
        const { notice, submitAgentExact, write } = harness({ enabled: false });

        await expect(notice('session-1', URL)).resolves.toBe('disabled');

        expect(submitAgentExact).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it.each([
        ['no-session', { session: undefined }],
        ['no-agent', { session: { primaryAgentTerminalId: null } }],
        ['no-agent', { terminal: { id: 'terminal-1', sessionId: 'session-1' } }],
        ['agent-not-running', { launchId: undefined }],
        ['rejected', { submit: 'rejected' as const }],
    ])('reports %s without throwing', async (outcome, overrides) => {
        const { notice, write } = harness(overrides);

        await expect(notice('session-1', URL)).resolves.toBe(outcome);

        expect(write).toHaveBeenCalledWith(
            'warn',
            expect.any(String),
            expect.objectContaining({ fields: { outcome } }),
        );
    });

    it('turns a delivery error into a logged failure', async () => {
        const { notice, submitAgentExact, write } = harness({});
        submitAgentExact.mockRejectedValueOnce(new Error('host gone'));

        await expect(notice('session-1', URL)).resolves.toBe('failed');

        expect(write).toHaveBeenCalledWith(
            'warn',
            expect.any(String),
            expect.objectContaining({ fields: { outcome: 'failed', error: 'host gone' } }),
        );
    });
});
