import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { agentChatRecoveryActions, agentChatRecoveryNotice } from '../agent-chat-presentation';

describe('agentChatRecoveryActions', () => {
    it('puts Settings before Retry for a missing CLI', () => {
        expect(agentChatRecoveryActions({ kind: 'failed', canOpenSettings: true }, true)).toEqual([
            'openSettings',
            'retry',
        ]);
    });

    it('offers Open as Terminal only when a Terminal can be opened', () => {
        const notice = { kind: 'failed', canOpenAsTerminal: true } as const;
        expect(agentChatRecoveryActions(notice, true)).toEqual(['openAsTerminal', 'retry']);
        expect(agentChatRecoveryActions(notice, false)).toEqual(['retry']);
    });

    it('resumes a hand-over and retries everything else', () => {
        expect(agentChatRecoveryActions({ kind: 'detached' }, true)).toEqual(['resume']);
        expect(agentChatRecoveryActions({ kind: 'inUse' }, true)).toEqual(['retry']);
    });
});

describe('agentChatRecoveryNotice for a missing CLI', () => {
    it('drops the raw English detail for a missing CLI and offers Settings', () => {
        const notice = agentChatRecoveryNotice(
            {
                status: 'failed',
                failure: { reason: 'executable_not_found', detail: 'Claude CLI was not found' },
            },
            { isLoadError: false, processState: 'failed' },
            'Claude Code',
            translate,
        );
        expect(notice).toEqual({
            kind: 'failed',
            message:
                "Caxri couldn't find Claude Code. Install it, or set its location in Settings.",
            recovery: 'restart',
            canOpenSettings: true,
        });
    });
});
