import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatFailureMessage, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { getTerminalExitPresentation } from '../../../terminal/terminal-exit-presentation';
import {
    agentChatSendBlock,
    agentChatSendTooltip,
    agentChatSendTooltipKeys,
    agentChatSendTooltipShortcut,
} from '../../composer/send/agent-chat-send-tooltip';
import {
    agentChatAttachLabel,
    agentChatCommandCwd,
    agentChatDeliveryCaption,
    agentChatEmptyHint,
    agentChatEscapeAction,
    agentChatRecoveryNotice,
    agentChatResumeFailureDetail,
    agentChatSendAction,
    agentChatSubmitDelivery,
    canSendAgentChatMessage,
    isAgentChatBusy,
    isAgentChatInterruptKey,
    withOccurrenceKeys,
} from '../agent-chat-presentation';

function snapshot(status: AgentChatSnapshot['status']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('terminal-1'), status };
}

describe('canSendAgentChatMessage', () => {
    it('accepts a message while ready, stopped (which resumes), or still starting (which queues)', () => {
        expect(canSendAgentChatMessage(snapshot('ready'), 'running')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'), 'stopped')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('starting'), 'starting')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'), undefined)).toBe(true);
    });

    it('refuses once the provider has failed or before anything is loaded', () => {
        expect(canSendAgentChatMessage(snapshot('failed'), 'failed')).toBe(false);
        expect(canSendAgentChatMessage(undefined, 'running')).toBe(false);
    });

    it('refuses a Chat handed to another client even though its projection reads stopped', () => {
        expect(canSendAgentChatMessage(snapshot('stopped'), 'detached')).toBe(false);
    });
});

describe('agentChatRecoveryNotice', () => {
    const settled = { isLoadError: false, processState: 'stopped' } as const;

    it('shows nothing while the Chat can continue', () => {
        expect(
            agentChatRecoveryNotice(snapshot('stopped'), settled, 'Codex', translate),
        ).toBeUndefined();
        expect(agentChatRecoveryNotice(undefined, settled, 'Codex', translate)).toBeUndefined();
    });

    it('names a hand-over with the PTY copy and resumes it by restarting the Terminal', () => {
        expect(
            agentChatRecoveryNotice(
                snapshot('stopped'),
                { isLoadError: false, processState: 'detached' },
                'Codex',
                translate,
            ),
        ).toEqual({
            kind: 'detached',
            message: getTerminalExitPresentation(
                'detached',
                undefined,
                undefined,
                undefined,
                translate,
            )?.label,
            recovery: 'restart',
        });
    });

    it('prefers the hand-over to an older provider failure', () => {
        expect(
            agentChatRecoveryNotice(
                { status: 'failed', failure: { reason: 'process_exited' } },
                { isLoadError: false, processState: 'detached' },
                'Codex',
                translate,
            )?.kind,
        ).toBe('detached');
    });

    it('restarts a failed provider and keeps its detail beside the closed message', () => {
        expect(
            agentChatRecoveryNotice(
                { status: 'failed', failure: { reason: 'spawn_failed', detail: 'EACCES' } },
                { isLoadError: false, processState: 'failed' },
                'Codex',
                translate,
            ),
        ).toEqual({
            kind: 'failed',
            message: agentChatFailureMessage('spawn_failed', {
                providerName: 'Codex',
                surface: 'desktop',
            }),
            detail: 'EACCES',
            recovery: 'restart',
        });
    });

    it('reads a conversation another client holds as neutral, without repeating the heading', () => {
        const notice = agentChatRecoveryNotice(
            {
                status: 'failed',
                failure: {
                    reason: 'conversation_in_use',
                    detail: 'Another Codex client is using this conversation',
                },
            },
            { isLoadError: false, processState: 'failed' },
            'Codex',
            translate,
        );
        expect(notice).toEqual({
            kind: 'inUse',
            message: 'This conversation is open in another Codex app or window.',
            detail: 'Close it there, then retry.',
            recovery: 'restart',
        });
    });

    it('reloads a projection that could not be read', () => {
        expect(
            agentChatRecoveryNotice(
                undefined,
                { isLoadError: true, processState: 'running' },
                'Codex',
                translate,
            ),
        ).toEqual({
            kind: 'failed',
            message: 'The conversation could not be loaded.',
            recovery: 'reload',
        });
    });
});

describe('agentChatSendAction', () => {
    it('sends when idle, queues while busy, and steers during a turn', () => {
        expect(
            agentChatSendAction({ isTurnRunning: false, isBusy: false }, 'Codex', translate),
        ).toEqual({
            kind: 'send',
            label: 'Send',
            tooltip: 'Send',
            shortcut: 'enter',
            placeholder: 'Message Codex',
        });
        expect(
            agentChatSendAction({ isTurnRunning: false, isBusy: true }, 'Codex', translate),
        ).toMatchObject({
            kind: 'queue',
            label: 'Queue message',
            tooltip: 'Queue',
            shortcut: 'enter',
        });
        // A running turn's tooltip lists its keys instead of the placeholder spelling them out.
        expect(
            agentChatSendAction({ isTurnRunning: true, isBusy: true }, 'Codex', translate),
        ).toMatchObject({
            kind: 'steer',
            label: 'Steer message',
            placeholder: 'Add to this turn',
            keys: [
                { label: 'Steer', shortcut: 'enter' },
                { label: 'Queue', shortcut: 'cmd+enter' },
                { label: 'Stop turn', shortcut: 'escape' },
            ],
        });
    });

    it('adds to the goal rather than the turn while an active goal runs', () => {
        expect(
            agentChatSendAction(
                { isTurnRunning: true, isBusy: true, isGoalActive: true },
                'Codex',
                translate,
            ),
        ).toMatchObject({ kind: 'steer', placeholder: 'Add to the goal' });
        expect(
            agentChatSendAction(
                { isTurnRunning: false, isBusy: false, isGoalActive: true },
                'Codex',
                translate,
            ),
        ).toMatchObject({ placeholder: 'Message Codex' });
    });

    it('asks what to plan in an idle Chat with plan mode on', () => {
        expect(
            agentChatSendAction(
                { isTurnRunning: false, isBusy: false, isPlanMode: true },
                'Codex',
                translate,
            ),
        ).toMatchObject({ label: 'Send', placeholder: 'Describe what to plan…' });
        // A running turn still invites a follow-up rather than a plan.
        expect(
            agentChatSendAction(
                { isTurnRunning: true, isBusy: true, isPlanMode: true },
                'Codex',
                translate,
            ),
        ).toMatchObject({ placeholder: 'Add to this turn' });
    });
});

describe('agentChatSendTooltip', () => {
    const action = { tooltip: 'Send (Enter)' };
    const ready = { block: undefined, hasContent: true, isAttaching: false, isSending: false };

    it('says why Send is disabled, putting the Chat refusal first', () => {
        expect(agentChatSendBlock(undefined, 'running')).toBe('loading');
        expect(agentChatSendBlock(snapshot('failed'), 'running')).toBe('failed');
        expect(agentChatSendBlock(snapshot('failed'), 'detached')).toBe('detached');
        expect(agentChatSendBlock(snapshot('ready'), 'running')).toBeUndefined();
        expect(agentChatSendTooltip(action, { ...ready, block: 'loading' }, translate)).toBe(
            'Chat loading…',
        );
        expect(agentChatSendTooltip(action, { ...ready, block: 'failed' }, translate)).toBe(
            'Chat stopped. Retry above',
        );
        expect(
            agentChatSendTooltip(
                action,
                { ...ready, block: 'detached', isAttaching: true },
                translate,
            ),
        ).toBe('Chat detached. Resume above');
        expect(agentChatSendTooltip(action, { ...ready, isAttaching: true }, translate)).toBe(
            'Attaching…',
        );
        expect(
            agentChatSendTooltip(
                action,
                {
                    ...ready,
                    isAttaching: true,
                    isPreparingReference: true,
                },
                translate,
            ),
        ).toBe('Preparing Session reference…');
        expect(agentChatSendTooltip(action, { ...ready, hasContent: false }, translate)).toBe(
            'Type a message to send',
        );
        expect(agentChatSendTooltip(action, ready, translate)).toBe('Send (Enter)');
    });

    it('shows the action’s keycap only while Send can act', () => {
        const send = { tooltip: 'Send', shortcut: 'enter' };
        expect(agentChatSendTooltipShortcut(send, ready, translate)).toBe('enter');
        expect(
            agentChatSendTooltipShortcut(send, { ...ready, hasContent: false }, translate),
        ).toBeUndefined();
        expect(
            agentChatSendTooltipShortcut(send, { ...ready, block: 'loading' }, translate),
        ).toBeUndefined();
        expect(
            agentChatSendTooltipShortcut({ tooltip: 'Queue' }, ready, translate),
        ).toBeUndefined();
    });

    it('lists the running turn keys only while Send can act', () => {
        const keys = [{ label: 'Queue', shortcut: 'enter' }];
        expect(agentChatSendTooltipKeys({ keys, tooltip: 'Queue' }, ready, translate)).toBe(keys);
        expect(
            agentChatSendTooltipKeys(
                { keys, tooltip: 'Queue' },
                { ...ready, isSending: true },
                translate,
            ),
        ).toBeUndefined();
        expect(agentChatSendTooltipKeys({ tooltip: 'Send' }, ready, translate)).toBeUndefined();
    });
});

describe('agentChatEmptyHint', () => {
    it('names the composer gestures, offering images only when the provider takes them', () => {
        expect(agentChatEmptyHint(true, translate)).toBe(
            'Type / or $ for commands and skills, @ for files and Sessions · paste or drop images and files · ⇧Enter for a new line',
        );
        expect(agentChatEmptyHint(false, translate)).toBe(
            'Type / or $ for commands and skills, @ for files and Sessions · drop files to insert paths · ⇧Enter for a new line',
        );
    });
});

describe('agentChatAttachLabel', () => {
    it('says a pick attaches files, and images only when the provider takes them', () => {
        expect(agentChatAttachLabel(true, false, translate)).toBe('Attach images or files');
        expect(agentChatAttachLabel(false, false, translate)).toBe('Attach files');
        expect(agentChatAttachLabel(true, true, translate)).toBe(
            'Attach images, files, or folders',
        );
        expect(agentChatAttachLabel(false, true, translate)).toBe('Attach files or folders');
    });
});

describe('agentChatSubmitDelivery', () => {
    const key = (overrides: Partial<Parameters<typeof agentChatSubmitDelivery>[0]> = {}) => ({
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: false,
        ...overrides,
    });
    const idle = { isTurnRunning: false, isBusy: false };
    const running = { isTurnRunning: true, isBusy: true };

    it('sends on Enter when idle, with or without Cmd', () => {
        expect(agentChatSubmitDelivery(key(), idle)).toBe('send');
        expect(agentChatSubmitDelivery(key({ metaKey: true }), idle)).toBe('send');
    });

    it('steers on Enter and queues on Cmd+Enter or Ctrl+Enter while a turn runs', () => {
        expect(agentChatSubmitDelivery(key(), running)).toBe('steer');
        expect(agentChatSubmitDelivery(key({ metaKey: true }), running)).toBe('queue');
        expect(agentChatSubmitDelivery(key({ ctrlKey: true }), running)).toBe('queue');
    });

    it('queues while compacting with or without Cmd, since there is no turn to steer', () => {
        const compacting = { isTurnRunning: false, isBusy: true };
        expect(agentChatSubmitDelivery(key(), compacting)).toBe('queue');
        expect(agentChatSubmitDelivery(key({ metaKey: true }), compacting)).toBe('queue');
    });

    it('leaves Shift+Enter, other keys, and an IME composition alone', () => {
        expect(agentChatSubmitDelivery(key({ shiftKey: true }), idle)).toBeUndefined();
        expect(agentChatSubmitDelivery(key({ isComposing: true }), running)).toBeUndefined();
        expect(agentChatSubmitDelivery(key({ key: 'a' }), idle)).toBeUndefined();
    });
});

describe('withOccurrenceKeys', () => {
    it('keys entries by content and numbers repeated values', () => {
        expect(
            withOccurrenceKeys(['Read', 'Test', 'Read'], (step) => step).map(({ key }) => key),
        ).toEqual(['Read\u{0}0', 'Test\u{0}0', 'Read\u{0}1']);
    });
});

describe('agentChatCommandCwd', () => {
    it('hides the Project root, shortens paths below it, and keeps paths outside it absolute', () => {
        expect(agentChatCommandCwd('/work/app', '/work/app')).toBeUndefined();
        expect(agentChatCommandCwd('/work/app/packages/ui', '/work/app')).toBe('packages/ui');
        expect(agentChatCommandCwd('/tmp/scratch', '/work/app')).toBe('/tmp/scratch');
        expect(agentChatCommandCwd('/work/app', undefined)).toBe('/work/app');
        expect(agentChatCommandCwd(undefined, '/work/app')).toBeUndefined();
    });
});

describe('isAgentChatBusy', () => {
    it('queues behind a running turn, a compaction, or an unpaused queue', () => {
        expect(isAgentChatBusy(snapshot('ready'))).toBe(false);
        expect(isAgentChatBusy({ ...snapshot('ready'), activeTurnId: 'turn-1' })).toBe(true);
        expect(isAgentChatBusy({ ...snapshot('ready'), operation: 'compacting' })).toBe(true);
        const queued = { ...snapshot('ready'), queue: [{ id: 'q1', text: 'next' }] };
        expect(isAgentChatBusy(queued)).toBe(true);
        expect(isAgentChatBusy({ ...queued, queuePaused: true })).toBe(false);
        expect(isAgentChatBusy(undefined)).toBe(false);
    });
});

describe('agentChatEscapeAction', () => {
    const escape = { key: 'Escape', isComposing: false, repeat: false };

    it('stops a running turn before it cancels an edit', () => {
        expect(agentChatEscapeAction(escape, { isTurnRunning: true, isEditing: true })).toBe(
            'stop',
        );
        expect(agentChatEscapeAction(escape, { isTurnRunning: false, isEditing: true })).toBe(
            'cancelEdit',
        );
    });

    it('does nothing when there is nothing to stop or cancel, or the key is not an interrupt', () => {
        expect(agentChatEscapeAction(escape, { isTurnRunning: false, isEditing: false })).toBe(
            undefined,
        );
        expect(
            agentChatEscapeAction(
                { ...escape, isComposing: true },
                { isTurnRunning: true, isEditing: true },
            ),
        ).toBe(undefined);
    });
});

describe('isAgentChatInterruptKey', () => {
    it('interrupts on a single Escape outside an IME composition', () => {
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: false, repeat: false })).toBe(
            true,
        );
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: true, repeat: false })).toBe(
            false,
        );
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: false, repeat: true })).toBe(
            false,
        );
        expect(isAgentChatInterruptKey({ key: 'Enter', isComposing: false, repeat: false })).toBe(
            false,
        );
    });
});

describe('agentChatRecoveryNotice for a conversation that could not be resumed', () => {
    it('explains the cause and the next step instead of repeating the provider detail', () => {
        const notice = agentChatRecoveryNotice(
            {
                status: 'failed',
                failure: {
                    reason: 'resume_failed',
                    detail: 'Claude could not resume this conversation',
                },
            },
            { isLoadError: false, processState: undefined },
            'Claude',
            translate,
        );
        expect(notice).toEqual({
            kind: 'failed',
            message: agentChatFailureMessage('resume_failed', {
                providerName: 'Claude',
                surface: 'desktop',
            }),
            detail: agentChatResumeFailureDetail('Claude', translate),
            recovery: 'restart',
            canOpenAsTerminal: true,
        });
        expect(notice?.detail).not.toContain('could not be resumed');
    });
});

describe('agentChatDeliveryCaption', () => {
    it('marks a steered message and drops the mark once a queued one was delivered', () => {
        expect(agentChatDeliveryCaption('steered', translate)).toBe(
            'Steered: sent while the Agent was working, so it joined the running turn',
        );
        expect(agentChatDeliveryCaption('queued', translate)).toBeUndefined();
        expect(agentChatDeliveryCaption(undefined, translate)).toBeUndefined();
    });
});
