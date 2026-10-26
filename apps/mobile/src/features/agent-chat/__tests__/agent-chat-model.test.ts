import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { mobileTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import {
    agentChatApprovalFiles,
    agentChatApprovalRows,
    agentChatComposerAvailability,
    agentChatComposerButton,
    agentChatComposerPressDeliveries,
    agentChatComposerRowControls,
    agentChatComposerSubmission,
    agentChatDisabledReason,
    agentChatEmptyMessage,
    agentChatHandedOffBanner,
    agentChatHandedOffNotice,
    agentChatImageCounts,
    agentChatImagesUnsupportedReason,
    agentChatProviderId,
    agentChatProviderName,
    agentChatRequestBlockedReason,
    agentChatSendFailureMessage,
    agentChatUsageGuardBanner,
    canAttachAgentChatImages,
    isAgentChatFailureRetryable,
    isAgentChatHandedOff,
    isAgentChatStopping,
    isAgentChatTerminal,
    shouldShowAgentChatStaleNotice,
} from '../agent-chat-model';

describe('shouldShowAgentChatStaleNotice', () => {
    it('reports only a failed read, not a Chat another screen covers', () => {
        expect(shouldShowAgentChatStaleNotice({ error: 'failed', status: 'stale' }, true)).toBe(
            true,
        );
        // The in-app browser covering the Chat stops observing it without any read failing.
        expect(shouldShowAgentChatStaleNotice({ error: null, status: 'stale' }, true)).toBe(false);
        // Offline, the connection banner explains the stale copy.
        expect(shouldShowAgentChatStaleNotice({ error: 'failed', status: 'stale' }, false)).toBe(
            false,
        );
        expect(shouldShowAgentChatStaleNotice({ error: null, status: 'ready' }, true)).toBe(false);
    });
});

const base: AgentChatSnapshot = {
    terminalId: 'terminal-1',
    revision: 4,
    status: 'ready',
    truncated: false,
    items: [],
    turns: [],
    requests: [],
};

describe('Agent Chat model', () => {
    it('recognizes a Chat Terminal and names its provider', () => {
        expect(isAgentChatTerminal({ surface: 'chat' })).toBe(true);
        expect(isAgentChatTerminal({})).toBe(false);
        expect(isAgentChatTerminal(undefined)).toBe(false);
        expect(agentChatProviderName({ kind: 'codex' })).toBe('Codex');
        expect(agentChatProviderName({ kind: 'grok', provider: 'grok' })).toBe('Grok Build');
        expect(agentChatProviderName({ kind: 'shell' })).toBe('the Agent');
        expect(agentChatProviderName(undefined)).toBe('the Agent');
    });

    it('names every Chat provider exactly as the Desktop catalog does', () => {
        for (const provider of agentProviderIds) {
            expect(agentChatProviderName({ kind: provider })).toBe(
                agentProviderCatalog[provider].displayName,
            );
            expect(agentChatProviderName({ kind: 'shell', provider })).toBe(
                agentProviderCatalog[provider].displayName,
            );
        }
        expect(agentChatProviderName({ kind: 'grok' })).toBe('Grok Build');
    });

    it('offers image attachments only to providers whose Chat takes images', () => {
        expect(canAttachAgentChatImages({ kind: 'claude' })).toBe(true);
        expect(canAttachAgentChatImages({ kind: 'codex' })).toBe(true);
        expect(canAttachAgentChatImages({ kind: 'grok' })).toBe(false);
        expect(canAttachAgentChatImages({ kind: 'shell' })).toBe(false);
        expect(canAttachAgentChatImages(undefined)).toBe(false);
    });

    it('counts the images each message carries, keyed for the Chat view', () => {
        expect(
            agentChatImageCounts({
                items: [
                    { id: 'u1', turnId: 't1', type: 'userMessage', text: '', images: [{}] },
                    { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Hi', streaming: true },
                ],
            }),
        ).toBe('[["u1",1]]');
        expect(agentChatImageCounts(undefined)).toBe('');
    });

    it('lists the files a file-change approval gates', () => {
        expect(
            agentChatApprovalFiles({ id: 'r', kind: 'fileChange', itemId: 'f1' }, [
                {
                    id: 'f1',
                    type: 'fileChange',
                    status: 'running',
                    changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }],
                },
            ]),
        ).toEqual(['src/a.ts']);
    });

    it('explains why the composer is unavailable, leaving a failed Chat to its banner', () => {
        expect(
            agentChatComposerAvailability({
                deviceRole: 'view',
                isConnected: true,
                isHandedOff: false,
                snapshot: base,
            }),
        ).toEqual({ isEnabled: false, reason: 'Reply access is required to message this Chat.' });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'reply',
                isConnected: true,
                isHandedOff: false,
                snapshot: { ...base, status: 'failed' },
            }),
        ).toEqual({ isEnabled: false });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: false,
                snapshot: base,
            }),
        ).toEqual({ isEnabled: true });
    });

    it('names the model, not sending, when the model cannot be changed', () => {
        const access = { isConnected: false, isHandedOff: false, snapshot: base } as const;
        expect(agentChatDisabledReason({ ...access, deviceRole: 'reply' })).toBe(
            'Reconnect to send messages.',
        );
        expect(
            agentChatDisabledReason({ ...access, action: 'configure', deviceRole: 'reply' }),
        ).toBe('Reconnect to change the model.');
        expect(
            agentChatDisabledReason({ ...access, action: 'configure', deviceRole: 'view' }),
        ).toBe('Reply access is required to change the model.');
    });

    it('needs control access to change permissions, where the model needs reply', () => {
        const live = { isConnected: true, isHandedOff: false, snapshot: base } as const;
        expect(
            agentChatDisabledReason({ ...live, action: 'permission', deviceRole: 'reply' }),
        ).toBe('Control access is required to change permissions.');
        expect(
            agentChatDisabledReason({ ...live, action: 'permission', deviceRole: 'control' }),
        ).toBeUndefined();
        expect(
            agentChatDisabledReason({
                ...live,
                action: 'permission',
                deviceRole: 'control',
                isConnected: false,
            }),
        ).toBe('Reconnect to change permissions.');
        expect(
            agentChatDisabledReason({ ...live, action: 'configure', deviceRole: 'reply' }),
        ).toBeUndefined();
    });

    it('reads the provider id from the Terminal for its permission levels', () => {
        expect(agentChatProviderId({ kind: 'codex' })).toBe('codex');
        expect(agentChatProviderId({ kind: 'shell', provider: 'claude' })).toBe('claude');
        expect(agentChatProviderId({ kind: 'shell' })).toBeUndefined();
        expect(agentChatProviderId(undefined)).toBeUndefined();
    });

    it('starts the unsupported-images reason with a capital for the providerless fallback', () => {
        expect(agentChatImagesUnsupportedReason('Grok Build')).toBe(
            'Grok Build Chat does not accept images',
        );
        expect(agentChatImagesUnsupportedReason('the Agent')).toBe(
            'The Agent Chat does not accept images',
        );
    });

    it('offers no Retry for a provider that must be installed or updated on the computer', () => {
        expect(isAgentChatFailureRetryable('executable_not_found')).toBe(false);
        expect(isAgentChatFailureRetryable('unsupported_version')).toBe(false);
        for (const reason of [
            'spawn_failed',
            'handshake_failed',
            'process_exited',
            'resume_failed',
        ] as const)
            expect(isAgentChatFailureRetryable(reason)).toBe(true);
    });

    it('blocks answering a request without control access or a connection', () => {
        expect(agentChatRequestBlockedReason({ deviceRole: 'reply', isConnected: true })).toEqual({
            kind: 'access',
            message:
                'This device cannot answer requests. Pair it again on your computer with control access.',
        });
        expect(agentChatRequestBlockedReason({ deviceRole: null, isConnected: false })?.kind).toBe(
            'access',
        );
        expect(
            agentChatRequestBlockedReason({ deviceRole: 'control', isConnected: false }),
        ).toEqual({ kind: 'offline', message: 'Reconnect to answer.' });
        expect(
            agentChatRequestBlockedReason({ deviceRole: 'control', isConnected: true }),
        ).toBeUndefined();
    });

    it('keeps Stop pending only for the turn it stopped', () => {
        expect(isAgentChatStopping('t1', 't1')).toBe(true);
        expect(isAgentChatStopping('t1', undefined)).toBe(false);
        expect(isAgentChatStopping('t1', 't2')).toBe(false);
        expect(isAgentChatStopping(undefined, 't1')).toBe(false);
        expect(isAgentChatStopping(undefined, undefined)).toBe(false);
    });

    it('lets the composer button act only when editable, and steer only a running turn with a draft', () => {
        const base = {
            hasDraft: true,
            isEditable: true,
            isRunning: false,
            isStopAction: false,
            isStopping: false,
        };
        expect(agentChatComposerSubmission(base)).toEqual({ canSteer: false, canSubmit: true });
        expect(agentChatComposerSubmission({ ...base, isRunning: true })).toEqual({
            canSteer: true,
            canSubmit: true,
        });
        expect(agentChatComposerSubmission({ ...base, hasDraft: false })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
        expect(
            agentChatComposerSubmission({
                ...base,
                hasDraft: false,
                isRunning: true,
                isStopAction: true,
            }),
        ).toEqual({ canSteer: false, canSubmit: true });
        expect(agentChatComposerSubmission({ ...base, isStopping: true })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
        expect(agentChatComposerSubmission({ ...base, isEditable: false })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
    });

    it('steers on a tap and queues on a hold during a turn, and sends on a tap otherwise (#2611)', () => {
        expect(agentChatComposerPressDeliveries({ canSteer: true })).toEqual({
            hold: 'queue',
            tap: 'steer',
        });
        expect(agentChatComposerPressDeliveries({ canSteer: false })).toEqual({
            hold: undefined,
            tap: 'send',
        });
    });

    it('labels the composer button Send, Steer, Stop, or Stopping', () => {
        const base = {
            isRunning: false,
            isStopAction: false,
            isStopping: false,
            provider: 'Codex',
        };
        expect(agentChatComposerButton(base)).toEqual({
            kind: 'send',
            label: 'Send message',
            testID: 'agent-chat-composer-send',
        });
        expect(agentChatComposerButton({ ...base, isRunning: true }).label).toBe('Steer message');
        expect(agentChatComposerButton({ ...base, isRunning: true, isStopAction: true })).toEqual({
            kind: 'stop',
            label: 'Stop Codex',
            testID: 'agent-chat-composer-stop',
        });
        expect(agentChatComposerButton({ ...base, isRunning: true, isStopping: true })).toEqual({
            kind: 'stop',
            label: 'Stopping Codex',
            testID: 'agent-chat-composer-stop',
        });
    });

    it('lays out one-time answers in a row and the standing answer below', () => {
        const all = [
            { decision: 'accept', label: 'Run' },
            { decision: 'acceptForSession', label: 'Always Allow in This Chat' },
            { decision: 'decline', label: 'Deny' },
        ];
        expect(agentChatApprovalRows(all).map((row) => row.map((c) => c.decision))).toEqual([
            ['accept', 'decline'],
            ['acceptForSession'],
        ]);
        expect(
            agentChatApprovalRows(all.filter((c) => c.decision !== 'acceptForSession')),
        ).toHaveLength(1);
        expect(agentChatApprovalRows([])).toEqual([]);
    });

    it('treats a detached Chat as handed off, the way the phone treats a detached Terminal', () => {
        expect(isAgentChatHandedOff({ lastProcessState: 'detached' })).toBe(true);
        for (const state of [
            'running',
            'starting',
            'stopped',
            'dead',
            'failed',
            'interrupted',
            'suspended',
        ] as const)
            expect(isAgentChatHandedOff({ lastProcessState: state })).toBe(false);
        expect(isAgentChatHandedOff(undefined)).toBe(false);
        /**
         * The notice names the Chat where the detached PTY chip names the Terminal; the rest of the sentence is shared.
         */
        expect(agentChatHandedOffNotice()).toBe('Chat was handed off on your computer');
        expect(agentChatHandedOffBanner()).toBe(
            'Chat was handed off on your computer. Resume it there to continue.',
        );
        expect(mobileTerminalExitPresentation('detached').label).toBe(
            agentChatHandedOffNotice().replace('Chat', 'Terminal'),
        );
    });

    it('disables sending to a handed-off Chat silently, since its banner says how to continue', () => {
        const stopped: AgentChatSnapshot = { ...base, status: 'stopped' };
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: true,
                snapshot: stopped,
            }),
        ).toEqual({ isEnabled: false });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'reply',
                isConnected: true,
                isHandedOff: true,
                snapshot: undefined,
            }),
        ).toEqual({ isEnabled: false });
        // Role and connection keep precedence, exactly as before.
        expect(
            agentChatComposerAvailability({
                deviceRole: 'view',
                isConnected: true,
                isHandedOff: true,
                snapshot: stopped,
            }).reason,
        ).toMatch(/Reply access/u);
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: false,
                isHandedOff: true,
                snapshot: stopped,
            }).reason,
        ).toBe('Reconnect to send messages.');
        // A stopped Chat that was not handed off still resumes on the next message.
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: false,
                snapshot: stopped,
            }),
        ).toEqual({ isEnabled: true });
    });

    it('disables sending at the weekly usage guard and lets the banner say why', () => {
        const NOW = Date.parse('2026-03-02T10:00:00.000Z');
        const usageGuard = {
            provider: 'claude' as const,
            usedPercent: 99.6,
            resetsAt: NOW + (2 * 24 + 3) * 3_600_000,
            handoff: 'available' as const,
        };
        const guarded: AgentChatSnapshot = { ...base, usageGuard };
        const input = { deviceRole: 'control', isConnected: true, isHandedOff: false } as const;
        expect(agentChatComposerAvailability({ ...input, snapshot: guarded })).toEqual({
            isEnabled: false,
        });
        expect(agentChatDisabledReason({ ...input, snapshot: guarded })).toBe(
            'Weekly usage is nearly used up. Hand off on your computer.',
        );
        // The model and permission level spend no usage, so they stay changeable.
        expect(
            agentChatDisabledReason({ ...input, action: 'configure', snapshot: guarded }),
        ).toBeUndefined();
        expect(agentChatUsageGuardBanner(usageGuard, 'Claude', NOW)).toBe(
            'Claude weekly usage is at 99%. New requests are paused for 2d 3h, until it resets. Hand off to another Agent on your computer.',
        );
    });

    it('does not invite a message into an empty Chat this device cannot send to', () => {
        expect(
            agentChatEmptyMessage({ canSend: true, isHandedOff: false, provider: 'Grok Build' }),
        ).toBe('No messages yet. Send a message to start working with Grok Build.');
        expect(
            agentChatEmptyMessage({ canSend: false, isHandedOff: false, provider: 'Grok Build' }),
        ).toBe('No messages yet.');
        for (const canSend of [true, false])
            expect(
                agentChatEmptyMessage({ canSend, isHandedOff: true, provider: 'Grok Build' }),
            ).toBe('No messages to show.');
    });
});

describe('agentChatSendFailureMessage', () => {
    it('says "not sent" only when the message provably did not reach the Agent', () => {
        expect(agentChatSendFailureMessage({ kind: 'rejected', code: 'CONFLICT' })).toBe(
            'Your message was not sent. Try again.',
        );
        expect(agentChatSendFailureMessage({ kind: 'rejected', code: 'FORBIDDEN' })).toContain(
            'not sent',
        );
        expect(agentChatSendFailureMessage({ kind: 'offline' })).toContain('not sent');
        const unknown = agentChatSendFailureMessage({ kind: 'unknown' });
        expect(unknown).toBe("Couldn't confirm delivery. Check the Chat before sending again.");
        expect(unknown).not.toContain('not sent');
    });
});

describe('agentChatComposerRowControls', () => {
    it('hides attach only while a running turn has typed text, so the input keeps its room', () => {
        expect(
            agentChatComposerRowControls({ canAttach: true, hasText: true, isRunning: true }),
        ).toEqual({ showsAttach: false });
        expect(
            agentChatComposerRowControls({ canAttach: true, hasText: false, isRunning: true }),
        ).toEqual({ showsAttach: true });
        expect(
            agentChatComposerRowControls({ canAttach: true, hasText: true, isRunning: false }),
        ).toEqual({ showsAttach: true });
        expect(
            agentChatComposerRowControls({ canAttach: false, hasText: false, isRunning: false }),
        ).toEqual({ showsAttach: false });
    });
});
