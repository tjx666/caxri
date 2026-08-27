import type { CommandExecutionContext } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    BinaryStreamControl,
    BinaryStreamTicketAuthority,
    BinaryStreamTicketError,
} from '../binary-stream-control';

const context: CommandExecutionContext = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'desktop-1', generation: 3 },
    connection: {
        serverId: 'a'.repeat(32),
        bootId: 'b'.repeat(32),
        stateEpoch: 'c'.repeat(32),
        clientId: 'desktop-1',
        connectionId: 'd'.repeat(32),
    },
};

afterEach(() => vi.restoreAllMocks());

describe('BinaryStreamTicketAuthority', () => {
    it('redeems a scope-bound ticket exactly once without encoding scope in the bearer', () => {
        const authority = new BinaryStreamTicketAuthority({
            createTicket: () => '1'.repeat(64),
            now: () => 100,
        });
        const operation = {
            method: 'terminal.attach' as const,
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
        };
        const grant = authority.issue(
            { context, connectionId: context.connection!.connectionId },
            operation,
            'request-1',
        );

        expect(grant.ticket).toBe('1'.repeat(64));
        expect(grant.ticket).not.toContain('terminal-1');
        expect(authority.redeem(grant.ticket)).toEqual({
            context,
            connectionId: context.connection!.connectionId,
            operation,
            requestId: 'request-1',
        });
        expect(() => authority.redeem(grant.ticket)).toThrow(BinaryStreamTicketError);
    });

    it('distinguishes expiry, stale generation, and capacity while staying bounded', () => {
        let now = 100;
        let nextTicket = 0;
        const authority = new BinaryStreamTicketAuthority({
            createTicket: () => `${(nextTicket += 1)}`.padStart(64, '0'),
            maximumTickets: 1,
            now: () => now,
            ticketTtlMs: 10,
        });
        const owner = { context, connectionId: context.connection!.connectionId };
        const operation = {
            method: 'files.read' as const,
            sessionId: 'session-1',
            path: '/project/file.txt',
        };
        const first = authority.issue(owner, operation, 'request-1');
        expect(() => authority.issue(owner, operation, 'request-2')).toThrow(/capacity-exceeded/u);
        now = 111;
        expect(() => authority.redeem(first.ticket)).toThrow(/ticket-expired/u);

        const second = authority.issue(owner, operation, 'request-3');
        authority.revokeConnection(owner.connectionId, 'stale-generation');
        authority.revokeConnection(owner.connectionId, 'server-unavailable');
        expect(() => authority.redeem(second.ticket)).toThrow(/stale-generation/u);
        expect(() => authority.issue(owner, operation, 'request-4')).toThrow(/stale-generation/u);
    });
});

describe('BinaryStreamControl ticket admission', () => {
    it('requires feature negotiation and an advertised command', () => {
        const authority = new BinaryStreamTicketAuthority({
            createTicket: () => '2'.repeat(64),
        });
        const control = new BinaryStreamControl({
            ticketAuthority: authority,
        });
        const request = {
            type: 'stream-ticket.request' as const,
            protocolVersion: 2 as const,
            id: 'request-1',
            operation: {
                method: 'files.read' as const,
                sessionId: 'session-1',
                path: '/project/file.txt',
            },
        };
        const owner = { context, connectionId: context.connection!.connectionId };

        const unnegotiated = control.issue(
            { ...owner, commands: ['files.read'], features: [] },
            request,
        );
        expect(unnegotiated?.ok).toBe(false);
        if (unnegotiated?.ok !== false) throw new Error('Expected ticket rejection');
        expect(unnegotiated.error.code).toBe('CONFLICT');
        const forbidden = control.issue(
            { ...owner, commands: [], features: ['binary-streams-v1'] },
            request,
        );
        expect(forbidden?.ok).toBe(false);
        if (forbidden?.ok !== false) throw new Error('Expected ticket rejection');
        expect(forbidden.error.code).toBe('FORBIDDEN');
        expect(
            control.issue(
                { ...owner, commands: ['files.read'], features: ['binary-streams-v1'] },
                request,
            ),
        ).toEqual(expect.objectContaining({ ok: true }));
    });

    it('captures the Server-owned generation without exposing it in the bearer grant', () => {
        const authority = new BinaryStreamTicketAuthority({
            createTicket: () => '3'.repeat(64),
        });
        const control = new BinaryStreamControl({
            terminalGeneration: () => 7,
            ticketAuthority: authority,
        });
        const response = control.issue(
            {
                commands: ['terminal.attach'],
                context,
                features: ['binary-streams-v1'],
            },
            {
                type: 'stream-ticket.request',
                protocolVersion: 2,
                id: 'request-2',
                operation: { method: 'terminal.attach', terminalId: 'terminal-1' },
            },
        );

        expect(response?.ok).toBe(true);
        if (!response?.ok) throw new Error('Expected ticket grant');
        expect(response.grant).not.toHaveProperty('terminalGeneration');
        expect(authority.redeem(response.grant.ticket)).toMatchObject({
            requestId: 'request-2',
            terminalGeneration: 7,
        });
    });
});
