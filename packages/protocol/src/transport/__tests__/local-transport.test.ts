import { describe, expect, it } from 'vitest';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../configuration/settings-spec';
import { serverCredentialTokenSchema, serverProcessIdentitySchema } from '../identity';
import {
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    desktopOperationSchema,
    desktopTargetPayloadSchema,
    localClientHelloSchema,
    localServerEventSchema,
    localServerWelcomeSchema,
    serverControlEndpointSchema,
    serverEndpointUrl,
} from '../local-transport';

describe('WebSocket control endpoint', () => {
    it('limits Session-free Project targets to directory reveal and editor operations', () => {
        const target = {
            targetId: 'target',
            projectId: 'project',
            kind: 'directory',
            path: '/project',
        };
        for (const operation of ['reveal', 'openInEditor'])
            expect(desktopTargetPayloadSchema.safeParse({ ...target, operation }).success).toBe(
                true,
            );
        for (const operation of ['open', 'trash'])
            expect(desktopTargetPayloadSchema.safeParse({ ...target, operation }).success).toBe(
                false,
            );
        expect(
            desktopTargetPayloadSchema.safeParse({ ...target, operation: 'reveal', kind: 'file' })
                .success,
        ).toBe(false);
        expect(
            desktopTargetPayloadSchema.safeParse({
                ...target,
                operation: 'reveal',
                projectId: undefined,
            }).success,
        ).toBe(false);
    });
    it('keeps enough headroom for the largest configurable editor payload', () => {
        const maximumEscapedDiffBytes = 2 * MAX_CONFIGURABLE_FILE_BYTES * 6;
        expect(CONTROL_TRANSPORT_MAX_FRAME_BYTES).toBeGreaterThan(maximumEscapedDiffBytes);
    });

    it('accepts only the fixed IPv4 loopback control endpoint', () => {
        const endpoint = {
            protocol: 'ws',
            host: '127.0.0.1',
            port: 41_337,
            path: '/control',
        } as const;
        expect(serverControlEndpointSchema.parse(endpoint)).toEqual(endpoint);
        expect(serverEndpointUrl(endpoint)).toBe('ws://127.0.0.1:41337/control');
        expect(
            serverControlEndpointSchema.safeParse({ ...endpoint, host: '0.0.0.0' }).success,
        ).toBe(false);
        expect(serverControlEndpointSchema.safeParse({ ...endpoint, path: '/other' }).success).toBe(
            false,
        );
        expect(serverControlEndpointSchema.safeParse({ ...endpoint, port: 0 }).success).toBe(false);
    });
});

describe('local transport credential and identity schemas', () => {
    it('requires exactly 64 lowercase hex characters for a credential token', () => {
        expect(serverCredentialTokenSchema.safeParse('a'.repeat(64)).success).toBe(true);
        expect(serverCredentialTokenSchema.safeParse('a'.repeat(63)).success).toBe(false);
        expect(serverCredentialTokenSchema.safeParse('A'.repeat(64)).success).toBe(false);
    });

    it('requires exactly 32 lowercase hex characters for a process identity', () => {
        expect(serverProcessIdentitySchema.safeParse('b'.repeat(32)).success).toBe(true);
        expect(serverProcessIdentitySchema.safeParse('b'.repeat(31)).success).toBe(false);
    });
});

describe('local transport hello / welcome envelopes', () => {
    it('discriminates operator, agent, and desktop client credentials by kind', () => {
        const base = {
            type: 'hello' as const,
            supportedVersions: [2],
            profileId: 'profile-1',
            clientId: 'client-1',
        };
        expect(
            localClientHelloSchema.safeParse({
                ...base,
                credential: { kind: 'operator', token: 'a'.repeat(64) },
            }).success,
        ).toBe(true);
        expect(
            localClientHelloSchema.safeParse({
                ...base,
                credential: {
                    kind: 'agent',
                    hostId: 'b'.repeat(32),
                    endpointId: 'endpoint-1',
                    generation: 1,
                    token: 'a'.repeat(64),
                },
            }).success,
        ).toBe(true);
        expect(
            localClientHelloSchema.safeParse({
                ...base,
                credential: { kind: 'desktop', token: 'a'.repeat(64), desktopId: 'desktop-1' },
            }).success,
        ).toBe(true);
        expect(
            localClientHelloSchema.safeParse({
                ...base,
                credential: { kind: 'unknown-kind', token: 'a'.repeat(64) },
            }).success,
        ).toBe(false);
    });

    it('accepts a welcome envelope with an optional desktop lease', () => {
        const welcome = {
            type: 'welcome' as const,
            profileId: 'profile-1',
            processIdentity: 'b'.repeat(32),
            protocolVersion: 2,
            principal: { kind: 'human-cli', id: 'cli-1' },
            capabilities: [],
            commands: [],
            features: [],
            connection: {
                serverId: 'a'.repeat(32),
                bootId: 'b'.repeat(32),
                stateEpoch: 'c'.repeat(32),
                clientId: 'client-1',
                connectionId: 'd'.repeat(32),
            },
        };
        expect(localServerWelcomeSchema.safeParse(welcome).success).toBe(true);
        expect(
            localServerWelcomeSchema.safeParse({
                ...welcome,
                desktopLease: { desktopId: 'desktop-1', generation: 1, expiresAt: 1 },
            }).success,
        ).toBe(true);
    });
});

describe('desktopOperationSchema', () => {
    it('discriminates status/focus operations without a target from open/reveal operations that require one', () => {
        expect(desktopOperationSchema.safeParse({ kind: 'status' }).success).toBe(true);
        expect(desktopOperationSchema.safeParse({ kind: 'focus' }).success).toBe(true);
        expect(desktopOperationSchema.safeParse({ kind: 'open' }).success).toBe(false);
        expect(
            desktopOperationSchema.safeParse({ kind: 'open', targetId: 'target-1' }).success,
        ).toBe(true);
        expect(
            desktopOperationSchema.safeParse({ kind: 'reveal', targetId: 'target-1' }).success,
        ).toBe(true);
    });
});

describe('desktopTargetPayloadSchema', () => {
    it('constrains the operation and kind enums for a target open/reveal request', () => {
        const base = {
            targetId: 'target-1',
            sessionId: 'session-1',
            path: '/private/tmp/example',
        };
        expect(
            desktopTargetPayloadSchema.safeParse({ ...base, operation: 'open', kind: 'file' })
                .success,
        ).toBe(true);
        expect(
            desktopTargetPayloadSchema.safeParse({
                ...base,
                operation: 'delete',
                kind: 'file',
            }).success,
        ).toBe(false);
    });
});

describe('localServerEventSchema', () => {
    it('accepts either a durable protocol envelope or a bare transient event', () => {
        expect(
            localServerEventSchema.safeParse({
                type: 'event',
                event: {
                    protocolVersion: 2,
                    cursor: 1,
                    event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
                },
            }).success,
        ).toBe(true);
        expect(
            localServerEventSchema.safeParse({
                type: 'event',
                event: {
                    event: 'terminal.output',
                    payload: { terminalId: 'terminal-1', data: 'hi' },
                },
            }).success,
        ).toBe(true);
        expect(
            localServerEventSchema.safeParse({
                type: 'event',
                event: { event: 'terminal.output', payload: { data: 'missing terminalId' } },
            }).success,
        ).toBe(false);
    });
});
