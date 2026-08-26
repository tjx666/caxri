import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { TerminalHostRequestEnvelope } from '../protocol';
import {
    authorizeTerminalHostRequest,
    isBoundedTerminalHostMessage,
    isTerminalHostResult,
    MAX_TERMINAL_HOST_MESSAGE_BYTES,
    terminalHostMessageSchema,
    terminalHostRequestEnvelopeSchema,
} from '../protocol';

const credential = 'a'.repeat(64);
const serverId = 'b'.repeat(32);
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
        protocolVersion: 1,
        id: 'request-1',
        credential,
        serverId,
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
    credential,
    serverId,
    launchGeneration: () => 1,
    terminal: (terminalId: string) =>
        terminalId === terminal.id
            ? {
                  sessionId: terminal.sessionId,
                  ptyGeneration: 1,
                  attachmentId: 'attachment-1',
              }
            : undefined,
};

describe('architecture-a3b-terminal-host: private protocol', () => {
    it('accepts a bounded launch plan bound to the exact Server and Terminal generation', () => {
        expect(authorizeTerminalHostRequest(startEnvelope(), liveAuthority)).toEqual({ ok: true });
    });

    it("accepts Core's first positive generation when a replacement Host has no baseline", () => {
        const envelope = startEnvelope();
        if (envelope.scope.scope !== 'terminal') throw new Error('Expected Terminal scope');
        envelope.scope.ptyGeneration = 7;
        expect(
            authorizeTerminalHostRequest(envelope, {
                credential,
                serverId,
                launchGeneration: () => {},
                terminal: () => {},
            }),
        ).toEqual({ ok: true });
    });

    it.each([
        ['credential', { credential: 'c'.repeat(64) }],
        ['server', { serverId: 'd'.repeat(32) }],
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
            protocolVersion: 1,
            id: 'request-2',
            credential,
            serverId,
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

    it('allows attach to rotate an attachment while rejecting a mismatched requested attachment', () => {
        const base = {
            type: 'request',
            protocolVersion: 1,
            id: 'request-3',
            credential,
            serverId,
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
                serverId,
                protocolVersion: 1,
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

    it('validates every method result at the private process boundary', () => {
        expect(isTerminalHostResult('terminal.start', { processId: 42 })).toBe(true);
        expect(isTerminalHostResult('terminal.start', { processId: 0 })).toBe(false);
        expect(isTerminalHostResult('terminal.input', { accepted: true })).toBe(true);
        expect(isTerminalHostResult('terminal.input', { accepted: 'yes' })).toBe(false);
        expect(isTerminalHostResult('host.shutdown', { stopped: true, snapshots: [] })).toBe(true);
        expect(isTerminalHostResult('host.shutdown', { stopped: true })).toBe(false);
    });
});
