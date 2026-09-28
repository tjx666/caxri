import type { PermissionAutoAllowStatus, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

interface AutoAllowGrant {
    grantedAt: number;
    /**
     * Per-lifetime aggregate for the diagnostics invariant: a repeated, non-deduplicated event still needs a running
     * total so a log reader can answer "how many" without counting every individual line.
     */
    autoAllowCount: number;
}

export type PermissionAutoAllowRevokeReason = 'agentRestart' | 'sessionDeleted' | 'user';

/**
 * The grant operations `agent-runtime.ts` exposes to the Desktop and mobile handlers (issue caxri#1295).
 */
export interface PermissionAutoAllowAccess {
    attentionAutoAllowStatus: (sessionId: string) => PermissionAutoAllowStatus;
    /**
     * Also owns the transition log and the live `agent.permissionAutoAllowChanged` event.
     */
    grantAutoAllow: (sessionId: string) => PermissionAutoAllowStatus;
    revokeAutoAllow: (
        sessionId: string,
        reason: PermissionAutoAllowRevokeReason,
    ) => PermissionAutoAllowStatus;
}

/**
 * Session-scoped, Server in-memory-only grant that lets `onAttention` (see `agent-runtime.ts`) auto-answer every later
 * Claude permission request in the same Session without a mobile card or the native prompt. Never persisted: the grant
 * is deliberately gone after a Server restart, and it is explicitly revoked when the Session's Agent Terminal launch
 * ends (an owner-decided "Agent restarts" boundary) or the Session itself is deleted. Question requests are never
 * covered; callers gate that separately (see `shouldAutoAllowAttention`).
 *
 * @see docs/mobile/conversation.md for the full lifecycle and the owner decision this implements
 *   (issue caxri#1295).
 */
export class AgentAttentionAutoAllow {
    readonly #grants = new Map<string, AutoAllowGrant>();

    grant(sessionId: string): PermissionAutoAllowStatus {
        const grant: AutoAllowGrant = { grantedAt: Date.now(), autoAllowCount: 0 };
        this.#grants.set(sessionId, grant);
        return { granted: true, grantedAt: grant.grantedAt };
    }

    /**
     * Clears a grant, if one was active. The caller decides whether a no-op revoke (nothing was granted) still needs a
     * log line or event; both are skipped when `revoked` is false so a routine Terminal close does not spam a Session
     * that never had the grant enabled.
     */
    revoke(sessionId: string): { autoAllowCount: number; revoked: boolean } {
        const grant = this.#grants.get(sessionId);
        this.#grants.delete(sessionId);
        return { autoAllowCount: grant?.autoAllowCount ?? 0, revoked: Boolean(grant) };
    }

    isGranted(sessionId: string): boolean {
        return this.#grants.has(sessionId);
    }

    status(sessionId: string): PermissionAutoAllowStatus {
        const grant = this.#grants.get(sessionId);
        return grant ? { granted: true, grantedAt: grant.grantedAt } : { granted: false };
    }

    /**
     * Records one auto-allowed permission request against its Session's grant and returns the running count for the
     * structured log line. Returns 0 without recording anything when the Session has no active grant, which should not
     * happen given the call order in `onAttention` but keeps this method safe to call independently in tests.
     */
    recordAutoAllow(sessionId: string): number {
        const grant = this.#grants.get(sessionId);
        if (!grant) return 0;
        grant.autoAllowCount += 1;
        return grant.autoAllowCount;
    }
}

/**
 * Whether one attention request should be auto-answered under a Session's active grant. Question requests
 * (`AskUserQuestion`) are never auto-answered even while a Session's grant is active: the owner decision scopes "Always
 * allow" to permission risk only, and silently picking a multiple-choice or free-text answer on the user's behalf is a
 * different, unauthorized kind of automation.
 */
export function shouldAutoAllowAttention(
    attentionKind: 'permission' | 'question',
    isGranted: boolean,
): boolean {
    return isGranted && attentionKind === 'permission';
}

export interface PermissionAutoAllowController {
    grant(sessionId: string): PermissionAutoAllowStatus;
    revoke(sessionId: string, reason: PermissionAutoAllowRevokeReason): PermissionAutoAllowStatus;
    status(sessionId: string): PermissionAutoAllowStatus;
    isGranted(sessionId: string): boolean;
    recordAutoAllow(sessionId: string): number;
}

/**
 * Wraps `AgentAttentionAutoAllow` so every mutation (`grant`/`revoke`) always emits its structured transition log and
 * the live `agent.permissionAutoAllowChanged` event together (issue caxri#1295). Kept separate from `agent-runtime.ts`
 * so the log/event side effects are unit-testable without composing the full Agent runtime.
 */
export function createPermissionAutoAllowController(options: {
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
}): PermissionAutoAllowController {
    const store = new AgentAttentionAutoAllow();
    const changed = (
        sessionId: string,
        status: PermissionAutoAllowStatus,
        reason: PermissionAutoAllowRevokeReason,
        autoAllowCount: number,
    ): void => {
        options.logger.write('info', logEventCatalog.agent.permissionAutoAllowChanged, {
            fields: { sessionId, granted: status.granted, reason, autoAllowCount },
        });
        options.send({
            event: 'agent.permissionAutoAllowChanged',
            payload: { sessionId, ...status },
        });
    };
    return {
        grant(sessionId) {
            const status = store.grant(sessionId);
            changed(sessionId, status, 'user', 0);
            return status;
        },
        /**
         * Silent no-op when the Session never had the grant enabled: an ordinary Terminal close on a Session that never
         * opted in must not spam logs or push a live event to every connected client.
         */
        revoke(sessionId, reason) {
            const { autoAllowCount, revoked } = store.revoke(sessionId);
            if (!revoked) return { granted: false };
            changed(sessionId, { granted: false }, reason, autoAllowCount);
            return { granted: false };
        },
        status: (sessionId) => store.status(sessionId),
        isGranted: (sessionId) => store.isGranted(sessionId),
        recordAutoAllow: (sessionId) => store.recordAutoAllow(sessionId),
    };
}
