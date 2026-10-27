import type { TerminalRecord } from '@caxri/protocol';
import { MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { TerminalHostAuthority } from '../authorization';
import { authorizeTerminalHostRequest } from '../authorization';
import type { TerminalHostRequestEnvelope } from '../protocol';
import {
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

function reserveEnvelope(ptyGeneration = 1): TerminalHostRequestEnvelope {
    const envelope = startEnvelope();
    return terminalHostRequestEnvelopeSchema.parse({
        ...envelope,
        id: 'request-reserve',
        scope: { ...envelope.scope, ptyGeneration },
        request: { method: 'terminal.reserve', params: terminal },
    });
}

const liveAuthority = {
    bootId,
    credential,
    isRetired: () => false,
    launchGeneration: () => 1,
    terminal: (terminalId: string) =>
        terminalId === terminal.id
            ? {
                  sessionId: terminal.sessionId,
                  ptyGeneration: 1,
                  attachmentId: 'attachment-1',
                  agentLaunchId: 'launch-1',
                  agentProcessId: 123,
                  running: true,
              }
            : undefined,
};

/**
 * Terminal Host state between `terminal.reserve` and `terminal.start` for generation 1.
 */
const reservedAuthority = {
    ...liveAuthority,
    terminal: (terminalId: string) =>
        terminalId === terminal.id
            ? { sessionId: terminal.sessionId, ptyGeneration: 1, running: false }
            : undefined,
};

describe('architecture-a3b-terminal-host: private protocol', () => {
    it('fences bounded Agent submissions to the started launch and PTY generation', () => {
        const base = startEnvelope();
        const submission = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            scope: { ...base.scope, capability: 'terminal.agent.input' },
            request: {
                method: 'terminal.agent.submit',
                params: { launchId: 'launch-1', text: '继续处理\n第二行' },
            },
        });
        expect(authorizeTerminalHostRequest(submission, liveAuthority)).toEqual({ ok: true });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({
                    ...submission,
                    scope: { ...submission.scope, ptyGeneration: 2 },
                }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'generation' });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({
                    ...submission,
                    request: {
                        ...submission.request,
                        params: { launchId: 'other', text: 'again' },
                    },
                }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'agent' });
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...submission,
                request: {
                    ...submission.request,
                    params: { launchId: 'launch-1', text: '中'.repeat(5_462) },
                },
            }).success,
        ).toBe(false);
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...submission,
                request: {
                    ...submission.request,
                    params: { launchId: 'launch-1', text: '\u{1B}[201~' },
                },
            }).success,
        ).toBe(false);
    });

    it('accepts a bounded launch plan bound to the exact reserved Server and Terminal generation', () => {
        expect(authorizeTerminalHostRequest(startEnvelope(), reservedAuthority)).toEqual({
            ok: true,
        });
    });

    it('rejects a start that no reservation on this Host boot covers', () => {
        expect(authorizeTerminalHostRequest(startEnvelope(), liveAuthority)).toEqual({
            ok: false,
            reason: 'generation',
        });
        expect(
            authorizeTerminalHostRequest(startEnvelope(), { ...liveAuthority, terminal: () => {} }),
        ).toEqual({ ok: false, reason: 'terminal' });
    });

    it('requires a reservation to name exactly the next generation after a started baseline', () => {
        const authority = { ...liveAuthority, launchGeneration: () => 3 };
        expect(authorizeTerminalHostRequest(reserveEnvelope(3), authority)).toEqual({ ok: true });
        expect(authorizeTerminalHostRequest(reserveEnvelope(2), authority)).toEqual({
            ok: false,
            reason: 'generation',
        });
        expect(authorizeTerminalHostRequest(reserveEnvelope(4), authority)).toEqual({
            ok: false,
            reason: 'generation',
        });
    });

    it('fences reserve and start for a permanently retired Terminal at any generation', () => {
        const retired: TerminalHostAuthority = {
            ...reservedAuthority,
            isRetired: (terminalId: string) => terminalId === terminal.id,
            launchGeneration: () => {},
        };
        expect(authorizeTerminalHostRequest(reserveEnvelope(1), retired)).toEqual({
            ok: false,
            reason: 'retired',
        });
        expect(authorizeTerminalHostRequest(reserveEnvelope(42), retired)).toEqual({
            ok: false,
            reason: 'retired',
        });
        expect(authorizeTerminalHostRequest(startEnvelope(), retired)).toEqual({
            ok: false,
            reason: 'retired',
        });
    });

    it('seals a stopping generation against driving requests and holds the next reservation until the stop lands', () => {
        const live = liveAuthority.terminal(terminal.id)!;
        const sealedAuthority = (isRunning: boolean): TerminalHostAuthority => ({
            ...liveAuthority,
            launchGeneration: () => 2,
            terminal: (terminalId) =>
                terminalId === terminal.id
                    ? { ...live, running: isRunning, sealed: true }
                    : undefined,
        });
        const generationRequest = (
            request: TerminalHostRequestEnvelope['request'],
            capability: 'terminal.input' | 'terminal.view' | 'terminal.lifecycle',
            attachmentId?: string,
        ) =>
            terminalHostRequestEnvelopeSchema.parse({
                ...startEnvelope(),
                scope: {
                    ...startEnvelope().scope,
                    capability,
                    ...(attachmentId && { attachmentId }),
                },
                request,
            });
        const input = generationRequest(
            { method: 'terminal.input', params: { data: 'late' } },
            'terminal.input',
            'attachment-1',
        );
        const repeatedStop = generationRequest(
            { method: 'terminal.stop', params: { persistSnapshot: true } },
            'terminal.lifecycle',
        );
        const snapshot = generationRequest(
            { method: 'terminal.snapshot', params: {} },
            'terminal.view',
        );

        const stopping = sealedAuthority(true);
        expect(authorizeTerminalHostRequest(input, stopping)).toEqual({
            ok: false,
            reason: 'sealed',
        });
        expect(authorizeTerminalHostRequest(snapshot, stopping)).toEqual({ ok: true });
        expect(authorizeTerminalHostRequest(repeatedStop, stopping)).toEqual({ ok: true });
        expect(authorizeTerminalHostRequest(reserveEnvelope(2), stopping)).toEqual({
            ok: false,
            reason: 'sealed',
        });

        const stopped = sealedAuthority(false);
        expect(authorizeTerminalHostRequest(reserveEnvelope(2), stopped)).toEqual({ ok: true });
        expect(authorizeTerminalHostRequest(startEnvelope(), stopped)).toEqual({
            ok: false,
            reason: 'sealed',
        });
        expect(authorizeTerminalHostRequest(input, stopped)).toEqual({
            ok: false,
            reason: 'sealed',
        });
    });

    it('accepts retirement only as a server-scoped lifecycle request', () => {
        const base = startEnvelope();
        const retire = terminalHostRequestEnvelopeSchema.parse({
            ...base,
            id: 'request-retire',
            scope: { scope: 'server', capability: 'terminal.lifecycle' },
            request: { method: 'terminal.retire', params: { terminalId: terminal.id } },
        });
        expect(authorizeTerminalHostRequest(retire, liveAuthority)).toEqual({ ok: true });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({ ...retire, scope: base.scope }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'scope' });
        expect(
            authorizeTerminalHostRequest(
                terminalHostRequestEnvelopeSchema.parse({
                    ...retire,
                    scope: { scope: 'server', capability: 'terminal.inspect' },
                }),
                liveAuthority,
            ),
        ).toEqual({ ok: false, reason: 'capability' });
        expect(
            terminalHostRequestEnvelopeSchema.safeParse({
                ...retire,
                request: { ...retire.request, params: { terminalId: terminal.id, extra: true } },
            }).success,
        ).toBe(false);
        expect(isTerminalHostResult('terminal.retire', { retired: true })).toBe(true);
        expect(isTerminalHostResult('terminal.retire', { retired: false })).toBe(false);
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

    it('requires an observer gap reason at the Host boundary', () => {
        const gap = {
            type: 'event',
            event: 'terminal.observer.gap',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
            },
            sequence: 1,
        };
        expect(terminalHostMessageSchema.safeParse(gap).success).toBe(false);
        expect(terminalHostMessageSchema.safeParse({ ...gap, reason: 'resize' }).success).toBe(
            true,
        );
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

    it("reserves Core's first positive generation when a replacement Host has no baseline", () => {
        expect(
            authorizeTerminalHostRequest(reserveEnvelope(7), {
                bootId,
                credential,
                isRetired: () => false,
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
        expect(authorizeTerminalHostRequest(candidate, reservedAuthority)).toEqual({
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
