import type { TerminalRecord } from '@caxri/protocol';
import { MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { TerminalHostRequestEnvelope } from '../protocol';
import {
    authorizeTerminalHostRequest,
    isBoundedTerminalHostMessage,
    isTerminalHostResult,
    MAX_TERMINAL_HOST_MESSAGE_BYTES,
    TERMINAL_HOST_PROTOCOL_VERSION,
    terminalHostMessageSchema,
    terminalHostRequestEnvelopeSchema,
} from '../protocol';

const credential = 'a'.repeat(64);
const bootId = 'b'.repeat(32);
const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    icon: 'terminal',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};

function startEnvelope(): TerminalHostRequestEnvelope {
    return terminalHostRequestEnvelopeSchema.parse({
        type: 'request',
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        id: 'request-1',
        bootId,
        credential,
        scope: {
            scope: 'terminal',
            capability: 'terminal.lifecycle',
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        },
        request: {
            method: 'terminal.start',
            params: {
                record: terminal,
                executable: '/bin/zsh',
                args: ['-l'],
                environment: { TERM: 'xterm-256color' },
            },
        },
    });
}

const liveAuthority = {
    bootId,
    credential,
    launchGeneration: () => 1,
    terminal: (terminalId: string) =>
        terminalId === terminal.id
            ? {
                  sessionId: terminal.sessionId,
                  ptyGeneration: 1,
                  attachmentId: 'attachment-1',
                  agentLaunchId: 'launch-1',
                  running: true,
              }
            : undefined,
};

describe('architecture-a3b-terminal-host: private protocol', () => {
    it('accepts a bounded launch plan bound to the exact Server and Terminal generation', () => {
        expect(authorizeTerminalHostRequest(startEnvelope(), liveAuthority)).toEqual({ ok: true });
    });

    it('uses the shared private Terminal input frame limit', () => {
        const envelope = startEnvelope();
        const candidate = {
            ...envelope,
            id: 'request-input-limit',
            request: {
                method: 'terminal.input',
                params: { data: 'x'.repeat(MAX_TERMINAL_INPUT_LENGTH) },
            },
            scope: {
                ...envelope.scope,
                attachmentId: 'attachment-1',
                capability: 'terminal.input',
            },
        };

        expect(terminalHostRequestEnvelopeSchema.safeParse(candidate).success).toBe(true);
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...candidate,
                request: {
                    ...candidate.request,
                    params: { data: 'x'.repeat(MAX_TERMINAL_INPUT_LENGTH + 1) },
                },
            }).success,
        ).toBe(false);
    });

    it('requires exact generation and unattached capabilities for mobile observer control', () => {
        const base = startEnvelope();
        const observe = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            id: 'observe-1',
            scope: { ...base.scope, capability: 'terminal.observe' },
            request: { method: 'terminal.observe', params: { observerId: 'observer-1' } },
        });
        expect(authorizeTerminalHostRequest(observe, liveAuthority)).toEqual({ ok: true });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({
                    ...observe,
                    scope: { ...observe.scope, attachmentId: 'attachment-1' },
                }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'attachment' });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({
                    ...observe,
                    scope: { ...observe.scope, ptyGeneration: 2 },
                }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'generation' });

        const takeOver = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            id: 'lease-1',
            scope: { ...base.scope, capability: 'terminal.lease' },
            request: {
                method: 'terminal.takeOver',
                params: {
                    holderId: 'connection:subscription',
                    size: { cols: 42, rows: 20 },
                    timeoutMs: 12_000,
                },
            },
        });
        expect(authorizeTerminalHostRequest(takeOver, liveAuthority)).toEqual({ ok: true });
        expect(
            authorizeTerminalHostRequest(
                { ...takeOver, scope: { ...takeOver.scope, capability: 'terminal.view' } },
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'capability' });
        const input = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            id: 'input-1',
            scope: { ...base.scope, capability: 'terminal.mobile.input' },
            request: { method: 'terminal.observer.input', params: { data: '\u{1B}' } },
        });
        expect(authorizeTerminalHostRequest(input, liveAuthority)).toEqual({ ok: true });
    });

    it('accepts only a strict structured Agent sub-plan', () => {
        const envelope = startEnvelope();
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...envelope,
                request: {
                    ...envelope.request,
                    params: {
                        ...envelope.request.params,
                        agent: {
                            launchId: 'launch-1',
                            provider: 'codex',
                            executable: '/usr/local/bin/codex',
                            args: ['resume', 'session-1'],
                            environment: { TERM: 'xterm-256color' },
                        },
                    },
                },
            }).success,
        ).toBe(true);
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...envelope,
                request: {
                    ...envelope.request,
                    params: {
                        ...envelope.request.params,
                        agent: {
                            launchId: 'launch-1',
                            provider: 'codex',
                            executable: '/usr/local/bin/codex',
                            args: [],
                            environment: {},
                            shellCommand: 'codex',
                        },
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('validates Agent lifecycle events and exact-launch signals', () => {
        const identity = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        expect(
            terminalHostMessageSchema.safeParse({
                type: 'event',
                event: 'terminal.agent.started',
                identity,
                launchId: 'launch-1',
                processId: 4244,
            }).success,
        ).toBe(true);
        expect(
            terminalHostMessageSchema.safeParse({
                type: 'event',
                event: 'terminal.agent.exit',
                identity,
                launchId: 'launch-1',
                exitCode: null,
                signal: 'SIGINT',
            }).success,
        ).toBe(true);

        const signal = terminalHostRequestEnvelopeSchema.parse({
            ...startEnvelope(),
            id: 'request-agent-signal',
            request: {
                method: 'terminal.agent.signal',
                params: { launchId: 'launch-1', signal: 'SIGHUP' },
            },
        });
        expect(authorizeTerminalHostRequest(signal, liveAuthority)).toEqual({ ok: true });
        expect(isTerminalHostResult('terminal.agent.signal', { accepted: true })).toBe(true);
    });

    it("accepts Core's first positive generation when a replacement Host has no baseline", () => {
        const envelope = startEnvelope();
        if (envelope.scope.scope !== 'terminal') throw new Error('Expected Terminal scope');
        envelope.scope.ptyGeneration = 7;
        expect(
            authorizeTerminalHostRequest(envelope, {
                bootId,
                credential,
                launchGeneration: () => {},
                terminal: () => {},
            }),
        ).toEqual({ ok: true });
    });

    it.each([
        ['credential', { credential: 'c'.repeat(64) }],
        ['boot', { bootId: 'd'.repeat(32) }],
        ['capability', { scope: { capability: 'terminal.view' } }],
        ['terminal', { scope: { terminalId: 'terminal-2' } }],
        ['session', { scope: { sessionId: 'session-2' } }],
        ['generation', { scope: { ptyGeneration: 2 } }],
        ['attachment', { scope: { attachmentId: 'attachment-1' } }],
    ] as const)('rejects a start with the wrong %s identity', (reason, patch) => {
        const envelope = startEnvelope();
        const scopePatch = 'scope' in patch ? patch.scope : undefined;
        const candidate = terminalHostRequestEnvelopeSchema.parse({
            ...envelope,
            ...patch,
            scope: { ...envelope.scope, ...scopePatch },
        });
        expect(authorizeTerminalHostRequest(candidate, liveAuthority)).toEqual({
            ok: false,
            reason,
        });
    });

    it.each([
        ['terminal', { terminalId: 'missing' }],
        ['session', { sessionId: 'session-2' }],
        ['generation', { ptyGeneration: 2 }],
        ['attachment', { attachmentId: 'attachment-2' }],
    ] as const)('rejects stale input by %s identity', (reason, identityPatch) => {
        const candidate = terminalHostRequestEnvelopeSchema.parse({
            type: 'request',
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            id: 'request-2',
            bootId,
            credential,
            scope: {
                scope: 'terminal',
                capability: 'terminal.input',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
                attachmentId: 'attachment-1',
                ...identityPatch,
            },
            request: { method: 'terminal.input', params: { data: 'echo safe\r' } },
        });
        expect(authorizeTerminalHostRequest(candidate, liveAuthority)).toEqual({
            ok: false,
            reason,
        });
    });

    it('allows background Agent input only for the exact live launch without a Renderer attachment', () => {
        const base = {
            type: 'request',
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            id: 'request-agent-input',
            bootId,
            credential,
            scope: {
                scope: 'terminal',
                capability: 'terminal.agent.input',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
            },
            request: {
                method: 'terminal.agent.input',
                params: { data: 'Continue\r', launchId: 'launch-1' },
            },
        } as const;
        const accepted = terminalHostRequestEnvelopeSchema.parse(base);
        expect(authorizeTerminalHostRequest(accepted, liveAuthority)).toEqual({ ok: true });

        const staleAgent = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            request: {
                ...base.request,
                params: { ...base.request.params, launchId: 'stale-launch' },
            },
        });
        expect(authorizeTerminalHostRequest(staleAgent, liveAuthority)).toEqual({
            ok: false,
            reason: 'agent',
        });

        const attached = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            scope: { ...base.scope, attachmentId: 'attachment-1' },
        });
        expect(authorizeTerminalHostRequest(attached, liveAuthority)).toEqual({
            ok: false,
            reason: 'attachment',
        });
    });

    it('allows attach to rotate an attachment while rejecting a mismatched requested attachment', () => {
        const base = {
            type: 'request',
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            id: 'request-3',
            bootId,
            credential,
            scope: {
                scope: 'terminal',
                capability: 'terminal.view',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
                attachmentId: 'attachment-2',
            },
            request: {
                method: 'terminal.attach',
                params: { attachmentId: 'attachment-2', size: { cols: 120, rows: 40 } },
            },
        } as const;
        const accepted = terminalHostRequestEnvelopeSchema.parse(base);
        expect(authorizeTerminalHostRequest(accepted, liveAuthority)).toEqual({ ok: true });
        const rejected = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            request: { ...base.request, params: { ...base.request.params, attachmentId: 'other' } },
        });
        expect(authorizeTerminalHostRequest(rejected, liveAuthority)).toEqual({
            ok: false,
            reason: 'attachment',
        });
    });

    it('rejects malformed and oversized private messages before dispatch', () => {
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...startEnvelope(),
                credential: 'secret',
            }).success,
        ).toBe(false);
        expect(
            terminalHostMessageSchema.safeParse({
                type: 'event',
                event: 'host.ready',
                bootId,
                protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
                appVersion: '0.0.18',
                buildId: 'build-1',
                commit: 'deadbeef',
                pid: 42,
            }).success,
        ).toBe(true);
        expect(isBoundedTerminalHostMessage({ data: 'x'.repeat(1_024) })).toBe(true);
        expect(
            isBoundedTerminalHostMessage({ data: 'x'.repeat(MAX_TERMINAL_HOST_MESSAGE_BYTES) }),
        ).toBe(false);
    });

    it('accepts only content-free bounded observation context', () => {
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...startEnvelope(),
                observation: {
                    operationId: 'terminal-operation-1',
                    requestId: 'request-1',
                    traceId: 'trace-1',
                },
            }).success,
        ).toBe(true);
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...startEnvelope(),
                observation: {
                    requestId: '/private/project/source.ts',
                    credential: 'secret-token',
                },
            }).success,
        ).toBe(false);
    });

    it('validates every method result at the private process boundary', () => {
        expect(isTerminalHostResult('terminal.start', { processId: 42 })).toBe(true);
        expect(isTerminalHostResult('terminal.start', { processId: 0 })).toBe(false);
        expect(isTerminalHostResult('terminal.input', { accepted: true })).toBe(true);
        expect(isTerminalHostResult('terminal.input', { accepted: 'yes' })).toBe(false);
        expect(isTerminalHostResult('terminal.agent.signal', { accepted: true })).toBe(true);
        expect(isTerminalHostResult('terminal.agent.signal', { accepted: 'yes' })).toBe(false);
        expect(isTerminalHostResult('host.shutdown', { stopped: true, snapshots: [] })).toBe(true);
        expect(isTerminalHostResult('host.shutdown', { stopped: true })).toBe(false);
    });
});
