import { describe, expect, it, vi } from 'vitest';

import type { PullRequestMergeNoticeOptions } from '../merge-notice';
import { createPullRequestMergeNotice, formatMergeNotice } from '../merge-notice';

const URL = 'https://github.com/acme/widget/pull/42';

function harness(overrides: {
    enabled?: boolean;
    launchId?: string;
    session?: { primaryAgentTerminalId?: string | null } | undefined;
    terminal?: Record<string, unknown> | undefined;
    submit?: 'accepted' | 'rejected' | 'unknown';
    withinTurn?: boolean;
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
        isWithinAgentTurn: () => overrides.withinTurn ?? false,
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

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe('sent');

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
            expect.objectContaining({ fields: { outcome: 'sent', origin: 'caxri' } }),
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

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe('sent');

        expect(send).toHaveBeenCalledWith('terminal-1', { text: formatMergeNotice(URL) });
        expect(submitAgentExact).not.toHaveBeenCalled();
    });

    it('does nothing and logs nothing while the setting is off', async () => {
        const { notice, submitAgentExact, write } = harness({ enabled: false });

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe('disabled');

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

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe(outcome);

        expect(write).toHaveBeenCalledWith(
            'warn',
            expect.any(String),
            expect.objectContaining({ fields: { outcome, origin: 'caxri' } }),
        );
    });

    it('turns a delivery error into a logged failure', async () => {
        const { notice, submitAgentExact, write } = harness({});
        submitAgentExact.mockRejectedValueOnce(new Error('host gone'));

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe('failed');

        expect(write).toHaveBeenCalledWith(
            'warn',
            expect.any(String),
            expect.objectContaining({
                fields: { outcome: 'failed', origin: 'caxri', error: 'host gone' },
            }),
        );
    });

    it('sends a merge detected elsewhere once, then reports the repeat as a duplicate', async () => {
        const { notice, submitAgentExact } = harness({});

        await expect(notice('session-1', URL, { origin: 'detected', mergedAt: 1 })).resolves.toBe(
            'sent',
        );
        await expect(notice('session-1', URL, { origin: 'detected', mergedAt: 1 })).resolves.toBe(
            'duplicate',
        );

        expect(submitAgentExact).toHaveBeenCalledTimes(1);
    });

    it('does not double-send when the sweep detects a merge the button already announced', async () => {
        const { notice, submitAgentExact } = harness({});

        await expect(notice('session-1', URL, { origin: 'caxri' })).resolves.toBe('sent');
        await expect(notice('session-1', URL, { origin: 'detected', mergedAt: 5 })).resolves.toBe(
            'duplicate',
        );

        expect(submitAgentExact).toHaveBeenCalledTimes(1);
    });

    it('skips a merge that landed inside the Agent turn, because the Agent merged it itself', async () => {
        const { notice, submitAgentExact, write } = harness({ withinTurn: true });

        await expect(notice('session-1', URL, { origin: 'detected', mergedAt: 5 })).resolves.toBe(
            'self-merged',
        );

        expect(submitAgentExact).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith(
            'info',
            expect.any(String),
            expect.objectContaining({ fields: { outcome: 'self-merged', origin: 'detected' } }),
        );
    });

    it('still announces a detected merge whose timestamp is unknown', async () => {
        const { notice } = harness({ withinTurn: true });

        await expect(notice('session-1', URL, { origin: 'detected' })).resolves.toBe('sent');
    });

    it('records nothing while the setting is off, so enabling it later can still announce', async () => {
        const state = { enabled: false };
        const { notice } = harness({
            get enabled() {
                return state.enabled;
            },
        });

        await expect(notice('session-1', URL, { origin: 'detected' })).resolves.toBe('disabled');
        state.enabled = true;
        await expect(notice('session-1', URL, { origin: 'detected' })).resolves.toBe('sent');
    });
});
