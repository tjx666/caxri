import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    describeMobileFailure,
    describeMobileStatus,
    findNewlyPairedDevice,
    isTailscalePairingLink,
    splitGrantableProjects,
    summarizeProjectAccess,
} from '../mobile-access-summary';

describe('summarizeProjectAccess', () => {
    it('joins every resolved title when none are unavailable', () => {
        expect(summarizeProjectAccess(translate, ['Caxri', 'Website'])).toBe('Caxri, Website');
    });

    it('collapses repeated unresolved grants into one trailing count', () => {
        expect(summarizeProjectAccess(translate, ['Caxri', undefined, undefined])).toBe(
            'Caxri · +2 unavailable',
        );
    });

    it('reports only the count when every grant is unresolved', () => {
        expect(summarizeProjectAccess(translate, [undefined, undefined, undefined])).toBe(
            '+3 unavailable',
        );
    });

    it('reads as empty when the device has no grants at all', () => {
        expect(summarizeProjectAccess(translate, [])).toBe('');
    });
});

describe('splitGrantableProjects', () => {
    it('offers only top-level Projects and remembers the worktree Project ids', () => {
        const result = splitGrantableProjects({
            view: 'desktop',
            projects: [
                { id: 'project-1', displayTitle: 'Caxri', rootPath: '$HOME/caxri' },
                {
                    id: 'project-2',
                    displayTitle: 'feature',
                    rootPath: '$HOME/caxri-worktrees/feature',
                    ownerProjectId: 'project-1',
                },
            ],
        });
        expect(result.projects.map(({ id }) => id)).toEqual(['project-1']);
        expect([...result.worktreeProjectIds]).toEqual(['project-2']);
    });
});

describe('describeMobileStatus', () => {
    it('never pairs an on title with an off detail', () => {
        expect(describeMobileStatus({ enabled: false }, 0)).toEqual({
            detailKey: 'settings.mobileAccess.status.offDetail',
            titleKey: 'settings.mobileAccess.status.off',
        });
        expect(
            describeMobileStatus({ address: '10.0.0.2', enabled: false, port: 1 }, 2).titleKey,
        ).toBe('settings.mobileAccess.status.off');
    });

    it('says it is waiting when enabled without an endpoint', () => {
        expect(describeMobileStatus({ enabled: true }, 0).detailKey).toBe(
            'settings.mobileAccess.status.waitingDetail',
        );
    });

    it('names the endpoint and pluralizes the device count', () => {
        const one = describeMobileStatus({ address: '10.0.0.2', enabled: true, port: 7 }, 1);
        expect(one.detailKey).toBe('settings.mobileAccess.status.listeningOne');
        expect(one.detailParams).toEqual({ address: '10.0.0.2', count: 1, port: 7 });
        expect(
            describeMobileStatus({ address: '10.0.0.2', enabled: true, port: 7 }, 0).detailKey,
        ).toBe('settings.mobileAccess.status.listeningOther');
    });
});

describe('describeMobileFailure', () => {
    const fallback = 'settings.mobileAccess.error.enable';

    it('maps the Server closed reasons to specific copy', () => {
        const reasons = [
            [
                'No private IPv4 network is available for mobile access',
                'settings.mobileAccess.error.noPrivateNetwork',
            ],
            [
                'The paired mobile endpoint is already in use',
                'settings.mobileAccess.error.portBusy',
            ],
            [
                'Mobile access could not open a local network endpoint',
                'settings.mobileAccess.error.endpointFailed',
            ],
        ] as const;
        for (const [message, key] of reasons)
            expect(describeMobileFailure(new CaxriError('UNAVAILABLE', message), fallback)).toBe(
                key,
            );
    });

    it('keeps the generic copy for unknown reasons and non-Caxri errors', () => {
        expect(describeMobileFailure(new CaxriError('INTERNAL', 'boom'), fallback)).toBe(fallback);
        expect(describeMobileFailure(new Error('x'), fallback)).toBe(fallback);
    });
});

describe('isTailscalePairingLink', () => {
    it('detects a 100.64.0.0/10 address in the link', () => {
        expect(
            isTailscalePairingLink('caxri://pair?addresses=192.168.1.4%2C100.101.2.3&port=1'),
        ).toBe(true);
    });

    it('ignores plain LAN addresses and malformed links', () => {
        expect(isTailscalePairingLink('caxri://pair?addresses=192.168.1.4,100.20.1.1')).toBe(false);
        expect(isTailscalePairingLink('not a url')).toBe(false);
    });
});

describe('findNewlyPairedDevice', () => {
    it('returns the first unrevoked device that was not known', () => {
        const devices = [
            { deviceId: 'a', displayName: 'Old', revokedAt: undefined },
            { deviceId: 'b', displayName: 'Gone', revokedAt: 5 },
            { deviceId: 'c', displayName: 'Pixel', revokedAt: undefined },
        ];
        expect(findNewlyPairedDevice(devices, new Set(['a']))).toBe('Pixel');
        expect(findNewlyPairedDevice(devices, new Set(['a', 'c']))).toBeUndefined();
    });
});
