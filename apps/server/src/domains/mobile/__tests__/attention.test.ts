import type { PermissionAutoAllowStatus } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { AgentAttentionRequests } from '../../agents';
import type { AgentTimelineService } from '../../agents/timeline';
import type { AgentTranscriptWatcher } from '../../agents/transcript-watcher';
import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import type { FileService } from '../../files';
import type { GitService } from '../../git';
import type { MobileTerminalMutationQueue } from '../../mobile-terminal-mutation-queue';
import type { TerminalManager } from '../../terminal';
import { createMobileDomainHandlers } from '../handlers';

const controlPrincipal = {
    kind: 'paired-device' as const,
    id: 'paired-device:fixture',
    deviceId: 'fixture',
    generation: 1,
    role: 'control' as const,
    projectIds: ['project-granted'],
};
const viewPrincipal = { ...controlPrincipal, role: 'view' as const };

const database = {
    getSession: () => ({ id: 'session-granted', projectId: 'project-granted' }),
    listVisibleProjects: () => [{ id: 'project-granted' }],
} as unknown as CaxriDatabase;

/**
 * Builds the handlers under test with a real `AgentAttentionRequests` store (so a card can actually be offered and
 * answered, matching `attention-requests.test.ts`) and spies for the three "Always allow in this Session" (issue
 * caxri#1295) callbacks that `agent-runtime.ts` normally supplies.
 */
function handlersWith(
    overrides: {
        attentionAutoAllowStatus?: (sessionId: string) => PermissionAutoAllowStatus;
        grantAutoAllow?: (sessionId: string) => PermissionAutoAllowStatus;
        revokeAutoAllow?: (sessionId: string, reason: string) => PermissionAutoAllowStatus;
    } = {},
) {
    const attentionRequests = new AgentAttentionRequests();
    return {
        attentionRequests,
        handlers: createMobileDomainHandlers({
            attentionRequests,
            configuration: {} as ConfigService,
            emit: vi.fn(),
            files: {} as FileService,
            database,
            git: {} as GitService,
            queue: {} as MobileTerminalMutationQueue,
            terminals: {} as TerminalManager,
            timeline: {} as AgentTimelineService,
            transcripts: {} as AgentTranscriptWatcher,
            autoAllow: overrides,
        }),
    };
}

describe('mobile.attention.listInternal', () => {
    it('reports the "Always allow in this Session" status alongside pending requests', async () => {
        const attentionAutoAllowStatus = vi.fn(() => ({ granted: true, grantedAt: 1_700 }));
        const { handlers } = handlersWith({ attentionAutoAllowStatus });

        const result = await handlers['mobile.attention.listInternal']({
            sessionId: 'session-granted',
            principal: viewPrincipal,
        });

        expect(result).toEqual({ requests: [], autoAllow: { granted: true, grantedAt: 1_700 } });
        expect(attentionAutoAllowStatus).toHaveBeenCalledExactlyOnceWith('session-granted');
    });

    it('defaults to ungranted when no status callback is supplied', async () => {
        const { handlers } = handlersWith();

        const result = await handlers['mobile.attention.listInternal']({
            sessionId: 'session-granted',
            principal: viewPrincipal,
        });

        expect(result.autoAllow).toEqual({ granted: false });
    });
});

describe('mobile.attention.answerInternal', () => {
    it('requires the control role, unaffected by the autoAllow field', () => {
        const { handlers, attentionRequests } = handlersWith();
        // A view-role answer is rejected before it reaches `attentionRequests.answer()`, so this request's Promise
        // never resolves within the test; see `attention-requests.test.ts` for the resolution path this discards.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void attentionRequests.offer({
            sessionId: 'session-granted',
            terminalId: 'terminal-one',
            launchId: 'launch-one',
            kind: 'permission',
            toolName: 'Bash',
            summary: 'git status',
            questions: [],
        });
        const requestId = attentionRequests.list('session-granted')[0].id;

        expect(() =>
            handlers['mobile.attention.answerInternal']({
                sessionId: 'session-granted',
                requestId,
                decision: 'allow',
                autoAllow: true,
                principal: viewPrincipal,
            }),
        ).toThrow(/Control access/u);
    });

    it('grants auto-allow only when the answer is "allow" and autoAllow was requested', async () => {
        const grantAutoAllow = vi.fn(() => ({ granted: true, grantedAt: 1 }));
        const { handlers, attentionRequests } = handlersWith({ grantAutoAllow });
        const offer = (): string => {
            // Deliberately discarded: each answer below resolves this Promise, but this test only checks whether
            // the answer grants auto-allow, not the resolution itself — already covered by attention-requests.test.ts.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void attentionRequests.offer({
                sessionId: 'session-granted',
                terminalId: 'terminal-one',
                launchId: 'launch-one',
                kind: 'permission',
                toolName: 'Bash',
                summary: 'git status',
                questions: [],
            });
            return attentionRequests.list('session-granted').at(-1)!.id;
        };

        // Plain "allow" without the field never grants.
        await handlers['mobile.attention.answerInternal']({
            sessionId: 'session-granted',
            requestId: offer(),
            decision: 'allow',
            principal: controlPrincipal,
        });
        expect(grantAutoAllow).not.toHaveBeenCalled();

        // "deny" with the field also never grants — only "allow" does.
        await handlers['mobile.attention.answerInternal']({
            sessionId: 'session-granted',
            requestId: offer(),
            decision: 'deny',
            autoAllow: true,
            principal: controlPrincipal,
        });
        expect(grantAutoAllow).not.toHaveBeenCalled();

        // "allow" with the field grants exactly once.
        await handlers['mobile.attention.answerInternal']({
            sessionId: 'session-granted',
            requestId: offer(),
            decision: 'allow',
            autoAllow: true,
            principal: controlPrincipal,
        });
        expect(grantAutoAllow).toHaveBeenCalledExactlyOnceWith('session-granted');
    });

    it('never grants when the answer itself is rejected', () => {
        const grantAutoAllow = vi.fn(() => ({ granted: true, grantedAt: 1 }));
        const { handlers } = handlersWith({ grantAutoAllow });

        expect(() =>
            handlers['mobile.attention.answerInternal']({
                sessionId: 'session-granted',
                requestId: 'missing-request',
                decision: 'allow',
                autoAllow: true,
                principal: controlPrincipal,
            }),
        ).toThrow(/not found/iu);
        expect(grantAutoAllow).not.toHaveBeenCalled();
    });
});

describe('mobile.attention.autoAllowRevokeInternal', () => {
    it('requires the control role', () => {
        const { handlers } = handlersWith();

        expect(() =>
            handlers['mobile.attention.autoAllowRevokeInternal']({
                sessionId: 'session-granted',
                principal: viewPrincipal,
            }),
        ).toThrow(/Control access/u);
    });

    it('revokes with reason "user" for a control device', async () => {
        const revokeAutoAllow = vi.fn(() => ({ granted: false }));
        const { handlers } = handlersWith({ revokeAutoAllow });

        const result = await handlers['mobile.attention.autoAllowRevokeInternal']({
            sessionId: 'session-granted',
            principal: controlPrincipal,
        });

        expect(result).toEqual({ granted: false });
        expect(revokeAutoAllow).toHaveBeenCalledExactlyOnceWith('session-granted', 'user');
    });
});
