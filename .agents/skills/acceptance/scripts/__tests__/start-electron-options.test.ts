import { describe, expect, it } from 'vitest';

import { DesktopLeaseBusyError } from '../../../switch-worktree/scripts/desktop-lease';
import { leaseWaitSecondsOption, parseOptions, withLeaseWaitHint } from '../start-electron-options';

describe('--lease-wait', () => {
    const wait = (...argv: string[]) => leaseWaitSecondsOption(parseOptions(argv));

    it('defaults to an immediate failure and accepts 1 to 1800 whole seconds', () => {
        expect(wait()).toBe(0);
        expect(wait('--lease-wait', '1')).toBe(1);
        expect(wait('--lease-wait', '1800')).toBe(1800);
    });

    it.each([['0'], ['1801'], ['1.5'], ['-3'], ['abc'], ['1e2']])('rejects %s', (value) => {
        expect(() => wait('--lease-wait', value)).toThrow(
            '--lease-wait requires an integer from 1 to 1800',
        );
    });

    it('rejects a missing value and a repeated flag', () => {
        expect(() => wait('--lease-wait')).toThrow('requires a value');
        expect(() => wait('--lease-wait', '5', '--lease-wait', '6')).toThrow(
            'only be provided once',
        );
    });

    it('points a busy lease at the flag only when no wait was requested', () => {
        const busy = new DesktopLeaseBusyError({
            acquiredAt: new Date().toISOString(),
            identity: 'identity',
            label: 'E2E',
            pid: 1,
            token: 'token',
            worktreeId: 'id',
            worktreePath: '/repo',
        });
        expect(String(withLeaseWaitHint(busy, 0))).toContain('--lease-wait <seconds> (1-1800)');
        expect(withLeaseWaitHint(busy, 30)).toBe(busy);
        const timedOut = new Error('Desktop is in use. Waited 30s.');
        expect(withLeaseWaitHint(timedOut, 30)).toBe(timedOut);
    });
});
