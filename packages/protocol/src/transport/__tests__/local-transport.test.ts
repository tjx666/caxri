import { describe, expect, it } from 'vitest';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../configuration/settings-spec';
import {
    desktopOperationSchema,
    desktopTargetPayloadSchema,
    hostCredentialTokenSchema,
    hostProcessIdentitySchema,
    LOCAL_TRANSPORT_MAX_FRAME_BYTES,
    localClientHelloSchema,
    LocalJsonLineDecoder,
    localServerEventSchema,
    localServerWelcomeSchema,
} from '../local-transport';

describe('LocalJsonLineDecoder', () => {
    it('decodes a multi-megabyte frame incrementally without retaining consumed prefixes', () => {
        const decoder = new LocalJsonLineDecoder();
        const body = 'x'.repeat(2 * 1024 * 1024);
        const frame = JSON.stringify({ body });
        const midpoint = Math.floor(frame.length / 2);

        expect(decoder.push(frame.slice(0, midpoint))).toEqual([]);
        expect(decoder.push(`${frame.slice(midpoint)}\n`)).toEqual([frame]);
    });

    it('rejects an unterminated frame above the shared transport bound', () => {
        const maximumEscapedDiffBytes = 2 * MAX_CONFIGURABLE_FILE_BYTES * 6;
        expect(LOCAL_TRANSPORT_MAX_FRAME_BYTES).toBeGreaterThan(maximumEscapedDiffBytes);
        const decoder = new LocalJsonLineDecoder(16);

        expect(() => decoder.push('x'.repeat(17))).toThrow(RangeError);
    });

    it('decodes multiple complete frames delivered in a single chunk, in order', () => {
        const decoder = new LocalJsonLineDecoder();
        const frames = [JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })];

        expect(decoder.push(`${frames[0]}\n${frames[1]}\n`)).toEqual(frames);
    });

    it('holds a trailing partial frame across pushes and resets its byte counter per line', () => {
        const decoder = new LocalJsonLineDecoder(32);
        const first = JSON.stringify({ a: 1 });

        expect(decoder.push(`${first}\n${'x'.repeat(10)}`)).toEqual([first]);
        // The partial trailing chunk from the previous push must not count against the next line's budget.
        expect(decoder.push(`${'y'.repeat(10)}\n`)).toEqual([`${'x'.repeat(10)}${'y'.repeat(10)}`]);
    });

    it('returns no lines for a chunk with no terminating newline', () => {
        const decoder = new LocalJsonLineDecoder();
        expect(decoder.push('{"incomplete":true}')).toEqual([]);
    });
});

describe('local transport credential and identity schemas', () => {
    it('requires exactly 64 lowercase hex characters for a credential token', () => {
        expect(hostCredentialTokenSchema.safeParse('a'.repeat(64)).success).toBe(true);
        expect(hostCredentialTokenSchema.safeParse('a'.repeat(63)).success).toBe(false);
        expect(hostCredentialTokenSchema.safeParse('A'.repeat(64)).success).toBe(false);
    });

    it('requires exactly 32 lowercase hex characters for a process identity', () => {
        expect(hostProcessIdentitySchema.safeParse('b'.repeat(32)).success).toBe(true);
        expect(hostProcessIdentitySchema.safeParse('b'.repeat(31)).success).toBe(false);
    });
});

describe('local transport hello / welcome envelopes', () => {
    it('discriminates operator, agent, and desktop client credentials by kind', () => {
        const base = { type: 'hello' as const, supportedVersions: [2], profileId: 'profile-1' };
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
