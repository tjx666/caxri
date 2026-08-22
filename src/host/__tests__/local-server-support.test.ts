import { describe, expect, it } from 'vitest';

import { CaxriError } from '../../shared/ipc/errors';
import { logEventCatalog } from '../../shared/ipc/logging';
import { CAXRI_PROTOCOL_VERSION } from '../../shared/ipc/version';
import type { LocalHostServerOptions } from '../local-server-support';
import {
    executeReply,
    fileSystemCode,
    isTokenMatch,
    operatorContext,
} from '../local-server-support';

type HostRequestLogEvent = Parameters<NonNullable<LocalHostServerOptions['logger']>['write']>[1];

describe('Host request log sink', () => {
    it('accepts only registered event names', () => {
        const registeredEvent: HostRequestLogEvent = logEventCatalog.ipc.request;
        // @ts-expect-error -- Host log sinks must reject events outside the canonical registry.
        const unregisteredEvent: HostRequestLogEvent = 'ipc.request_typo';

        expect(registeredEvent).toBe('ipc.request');
        expect(unregisteredEvent).toBe('ipc.request_typo');
    });
});

describe('isTokenMatch', () => {
    it('accepts two equal tokens', () => {
        expect(isTokenMatch('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects tokens of the same length that differ', () => {
        expect(isTokenMatch('shared-secreu', 'shared-secret')).toBe(false);
    });

    it('rejects tokens of different lengths without throwing', () => {
        expect(isTokenMatch('short', 'a-much-longer-candidate-token')).toBe(false);
    });

    it('rejects an empty candidate against a real token', () => {
        expect(isTokenMatch('', 'shared-secret')).toBe(false);
    });
});

describe('operatorContext', () => {
    it('grants the fixed operator capability set for the authenticated profile', () => {
        const context = operatorContext('profile-1');

        expect(context.principal).toEqual({ kind: 'human-cli', id: 'human-cli:profile-1' });
        expect(context.capabilities).toEqual(
            expect.arrayContaining([
                'desktop.window',
                'diagnostics.read',
                'agents.read',
                'agents.control',
                'agents.dispatch',
                'agents.grant',
                'events.read',
                'host.read',
                'host.stop',
                'projects.read',
                'sessions.read',
                'settings.read',
                'settings.write',
                'terminals.read',
                'terminals.steer',
            ]),
        );
        /**
         * Every capability in the list is intentional; an unexpected extra would silently widen what a human-CLI
         * connection can do.
         */
        expect(context.capabilities).toHaveLength(15);
    });

    it('derives the principal id from the profile id it is given', () => {
        expect(operatorContext('another-profile').principal).toEqual({
            kind: 'human-cli',
            id: 'human-cli:another-profile',
        });
    });
});

describe('executeReply', () => {
    it('wraps a resolved action as a successful reply envelope', async () => {
        await expect(executeReply('req-1', () => Promise.resolve({ value: 42 }))).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-1',
            ok: true,
            result: { value: 42 },
        });
    });

    it('reports a successful action that resolves to undefined', async () => {
        await expect(executeReply('req-2', () => Promise.resolve(undefined))).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-2',
            ok: true,
            result: undefined,
        });
    });

    it('shapes a rejected CaxriError into the wire error format', async () => {
        await expect(
            executeReply('req-3', () =>
                Promise.reject(
                    new CaxriError('NOT_FOUND', 'Session not found', { sessionId: 's1' }),
                ),
            ),
        ).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-3',
            ok: false,
            error: {
                code: 'NOT_FOUND',
                message: 'Session not found',
                details: { sessionId: 's1' },
            },
        });
    });

    it('decays an unrecognized failure into an INTERNAL wire error', async () => {
        await expect(
            executeReply('req-4', () => Promise.reject(new Error('boom'))),
        ).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-4',
            ok: false,
            error: { code: 'INTERNAL', message: 'boom' },
        });
    });
});

describe('fileSystemCode', () => {
    it('reads the code property off a Node.js filesystem error', () => {
        expect(fileSystemCode({ code: 'ENOENT' })).toBe('ENOENT');
    });

    it('stringifies a non-string code value', () => {
        expect(fileSystemCode({ code: 404 })).toBe('404');
    });

    it('returns undefined for an error object without a code', () => {
        expect(fileSystemCode(new Error('plain failure'))).toBeUndefined();
    });

    it('returns undefined for non-object thrown values', () => {
        expect(fileSystemCode('a string error')).toBeUndefined();
        expect(fileSystemCode(null)).toBeUndefined();
        expect(fileSystemCode(undefined)).toBeUndefined();
    });
});
