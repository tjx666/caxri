import { MOBILE_TRANSPORT_VERSION, serializeMobilePairingLink } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import {
    pairingLinkFromRouteParameters,
    readPairingRoute,
    startPairingRoute,
} from '../pairing-link-route';

const pairingLink = serializeMobilePairingLink({
    addresses: ['192.168.1.3'],
    expiresAt: 2_000_000_000_000,
    pairingId: '12'.repeat(16),
    port: 4_321,
    secret: '34'.repeat(32),
    serverId: 'server_test',
    version: MOBILE_TRANSPORT_VERSION,
});

const routeParameters = Object.fromEntries(new URL(pairingLink).searchParams);

describe('pairingLinkFromRouteParameters', () => {
    it('reconstructs the desktop pairing link from the /pair route', () => {
        expect(pairingLinkFromRouteParameters(routeParameters)).toBe(pairingLink);
    });

    it.each([
        { ...routeParameters, secret: undefined },
        { ...routeParameters, secret: [routeParameters.secret] },
        { ...routeParameters, unexpected: 'value' },
    ])('rejects an incomplete, repeated, or extended route contract', (parameters) => {
        expect(() => pairingLinkFromRouteParameters(parameters)).toThrow(
            'Pairing route parameters do not match the protocol',
        );
    });
});

describe('focused pairing route ownership', () => {
    it.each(['resolve', 'reject'] as const)(
        'ignores late %s after the route leaves',
        async (result) => {
            const pending = Promise.withResolvers<void>();
            const onSuccess = vi.fn();
            const onError = vi.fn();
            const cancel = vi.fn();
            const leave = startPairingRoute({
                link: pairingLink,
                pair: () => pending.promise,
                cancel,
                onSuccess,
                onError,
            });
            leave();
            leave();
            if (result === 'resolve') pending.resolve();
            else pending.reject(new Error('Late failure'));
            await Promise.resolve();
            expect(cancel).toHaveBeenCalledTimes(1);
            expect(onSuccess).not.toHaveBeenCalled();
            expect(onError).not.toHaveBeenCalled();
        },
    );

    it('lets a replacement link complete without adopting the older result', async () => {
        const old = Promise.withResolvers<void>();
        const newer = Promise.withResolvers<void>();
        const onSuccess = vi.fn();
        const onError = vi.fn();
        const cancel = vi.fn();
        const pair = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
        const leaveOld = startPairingRoute({ link: 'old-link', pair, cancel, onSuccess, onError });
        leaveOld();
        const leaveNew = startPairingRoute({ link: 'new-link', pair, cancel, onSuccess, onError });
        newer.resolve();
        await Promise.resolve();
        old.resolve();
        await Promise.resolve();
        leaveNew();
        expect(pair.mock.calls).toEqual([['old-link'], ['new-link']]);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('reports a current failure and keeps malformed links in the error state', async () => {
        const onError = vi.fn();
        startPairingRoute({
            link: pairingLink,
            pair: () => Promise.reject(new Error('Pairing failed')),
            cancel: vi.fn(),
            onSuccess: vi.fn(),
            onError,
        });
        await Promise.resolve();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(readPairingRoute({}).link).toBeUndefined();
        expect(typeof readPairingRoute({}).error).toBe('string');
        expect(readPairingRoute(routeParameters)).toEqual({ link: pairingLink, error: undefined });
    });
});
