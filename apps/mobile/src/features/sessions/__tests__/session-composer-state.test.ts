import { MOBILE_AGENT_SUBMIT_MAX_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    composerByteLength,
    composerDeliveryFeedback,
    composerDisabledReason,
    composerMutationIdForAttempt,
    composerTextError,
    reconcileStopWithSession,
    SessionComposerDeliveryStore,
    stopDisabledReason,
} from '../session-composer-state';
import type { MobileSessionItem } from '../session-model';

const session: MobileSessionItem = {
    id: 'session-one',
    projectId: 'project-one',
    title: 'Agent work',
    projectTitle: 'Project',
    lastVisitedAt: 100,
    sessionActivityAt: 100,
    agentActivityState: 'running',
    primaryAgentTerminalId: 'terminal-one',
    primaryAgentEndpoint: { hostId: 'host-one', endpointId: 'endpoint-one', generation: 2 },
    attentionGeneration: 1,
    hasUnread: false,
    primaryTerminal: {
        id: 'terminal-one',
        sessionId: 'session-one',
        kind: 'codex',
        provider: 'codex',
        lastProcessState: 'running',
    },
    group: 'working',
    stateLabel: 'Working',
};

describe('Session Composer state', () => {
    it('accepts multiline Chinese text and Tab within the UTF-8 limit', () => {
        const draft = '请检查这段代码\n\t并修复问题';
        expect(composerByteLength(draft)).toBeGreaterThan(draft.length);
        expect(composerTextError(draft, MOBILE_AGENT_SUBMIT_MAX_BYTES)).toBeNull();
        expect(
            composerTextError(
                '🙂'.repeat(MOBILE_AGENT_SUBMIT_MAX_BYTES / 4 + 1),
                MOBILE_AGENT_SUBMIT_MAX_BYTES,
            ),
        ).toContain('KB');
    });

    it('rejects control bytes and blank input without dropping the draft', () => {
        expect(composerTextError(' \n\t ', MOBILE_AGENT_SUBMIT_MAX_BYTES)).toContain('Write');
        for (const value of ['one\rtwo', 'one\u{1B}two', 'one\u{85}two']) {
            expect(composerTextError(value, MOBILE_AGENT_SUBMIT_MAX_BYTES)).toContain('control');
        }
    });

    it('names stale, role, endpoint, and stopped target reasons', () => {
        expect(composerDisabledReason(session, false, 'control')).toContain('Reconnect');
        expect(composerDisabledReason(session, true, 'view')).toContain('view');
        expect(composerDisabledReason(session, true, 'reply')).toBeNull();
        expect(
            composerDisabledReason(
                { ...session, primaryAgentEndpoint: undefined },
                true,
                'control',
            ),
        ).toContain('target');
        expect(
            composerDisabledReason(
                {
                    ...session,
                    primaryTerminal: { ...session.primaryTerminal!, lastProcessState: 'stopped' },
                },
                true,
                'control',
            ),
        ).toContain('not running');
    });

    it('allows Stop only with control role and a current running endpoint', () => {
        expect(stopDisabledReason(session, true, 'control')).toBeNull();
        expect(stopDisabledReason(session, true, 'reply')).toContain('Control');
        expect(
            stopDisabledReason({ ...session, primaryAgentEndpoint: undefined }, true, 'control'),
        ).toContain('target');
    });

    it('keeps Stop pending until Agent activity or its exact target changes', () => {
        const stopping = { kind: 'stopping', endpoint: session.primaryAgentEndpoint! } as const;
        expect(
            reconcileStopWithSession(
                stopping,
                session.primaryAgentEndpoint,
                session.primaryTerminal?.lastProcessState,
                'running',
            ),
        ).toBe(stopping);
        expect(
            reconcileStopWithSession(
                stopping,
                { ...session.primaryAgentEndpoint!, generation: 3 },
                'running',
                'running',
            ),
        ).toEqual({ kind: 'stopped' });
        expect(reconcileStopWithSession(stopping, undefined, 'running', 'running')).toEqual({
            kind: 'stopped',
        });
        expect(
            reconcileStopWithSession(stopping, session.primaryAgentEndpoint, 'stopped', 'running'),
        ).toEqual({ kind: 'stopped' });
        expect(
            reconcileStopWithSession(stopping, session.primaryAgentEndpoint, 'running', 'waiting'),
        ).toEqual({ kind: 'stopped' });
    });

    it('keeps unknown delivery and its mutation ID by Session across subscribers', () => {
        const store = new SessionComposerDeliveryStore();
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribe = store.subscribe('host-one\u{0}session-one', first);
        store.set('host-one\u{0}session-one', {
            kind: 'sending',
            mutationId: 'attempt-one',
            text: 'hello',
        });
        unsubscribe();
        store.set('host-one\u{0}session-one', {
            kind: 'unknown',
            mutationId: 'attempt-one',
            text: 'hello',
        });
        store.subscribe('host-one\u{0}session-one', second);
        expect(store.get('host-one\u{0}session-one')).toEqual({
            kind: 'unknown',
            mutationId: 'attempt-one',
            text: 'hello',
        });
        expect(store.get('host-one\u{0}session-two')).toEqual({ kind: 'idle' });
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });

    it('notifies a later subscriber when an earlier one throws', () => {
        const store = new SessionComposerDeliveryStore();
        const failing = vi.fn(() => {
            throw new Error('composer listener failure');
        });
        const surviving = vi.fn();
        const key = 'host-one\u{0}session-fanout';
        const unsubscribeFailing = store.subscribe(key, failing);
        const unsubscribeSurviving = store.subscribe(key, surviving);

        store.set(key, { kind: 'sending', mutationId: 'attempt-one', text: 'hello' });

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        unsubscribeFailing();
        unsubscribeSurviving();
    });

    it('reuses the unknown attempt ID only while the draft is unchanged', () => {
        const generate = vi.fn(() => 'attempt-two');
        const unknown = { kind: 'unknown', mutationId: 'attempt-one', text: 'hello' } as const;
        expect(composerMutationIdForAttempt(unknown, 'hello', generate)).toBe('attempt-one');
        expect(generate).not.toHaveBeenCalled();
        expect(composerMutationIdForAttempt(unknown, 'hello again', generate)).toBe('attempt-two');
        expect(generate).toHaveBeenCalledOnce();
        expect(
            composerMutationIdForAttempt(
                { kind: 'failed', message: 'No write' },
                'hello',
                generate,
            ),
        ).toBe('attempt-two');
    });

    it('distinguishes an accepted write from an unconfirmed write', () => {
        expect(composerDeliveryFeedback({ kind: 'accepted', mutationId: 'accepted-one' })).toEqual({
            message: 'Delivered to the Terminal.',
            isError: false,
        });
        expect(
            composerDeliveryFeedback({ kind: 'unknown', mutationId: 'unknown-one', text: 'draft' }),
        ).toEqual({
            message: "Couldn't confirm delivery. Check the Terminal before sending again.",
            isError: true,
        });
    });
});
