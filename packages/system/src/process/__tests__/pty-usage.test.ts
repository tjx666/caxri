import { describe, expect, it } from 'vitest';

import { isPtyAllocationError, isPtyUsageScanCommand, parseLsofPtyHolders } from '../pty-usage';

describe('parseLsofPtyHolders', () => {
    it('counts every open PTY master per process', () => {
        expect(parseLsofPtyHolders('p16681\nf20\nf25\nf29\np56596\nf23\n')).toEqual([
            { pid: 16681, count: 3 },
            { pid: 56596, count: 1 },
        ]);
    });

    it('ignores descriptor lines before a valid process line', () => {
        expect(parseLsofPtyHolders('f3\npnot-a-pid\nf4\np7\nf5\n')).toEqual([{ pid: 7, count: 1 }]);
    });

    it('returns no holders for empty output', () => {
        expect(parseLsofPtyHolders('')).toEqual([]);
    });
});

describe('isPtyAllocationError', () => {
    it.each(['forkpty(3) failed.', 'openpty(3) failed.', 'posix_openpt failed: EAGAIN'])(
        'recognizes the node-pty allocation failure %s',
        (message) => {
            expect(isPtyAllocationError(message)).toBe(true);
        },
    );

    it('does not match an unrelated spawn failure', () => {
        expect(isPtyAllocationError('spawn ENOENT')).toBe(false);
    });
});

describe('isPtyUsageScanCommand', () => {
    it("recognizes Caxri's own PTY queries but not another lsof", () => {
        expect(isPtyUsageScanCommand('/usr/sbin/lsof -n -P -F pf /dev/ptmx')).toBe(true);
        expect(isPtyUsageScanCommand('/usr/sbin/sysctl -n kern.tty.ptmx_max')).toBe(true);
        // `ps` names an exited, not yet reaped query by its bare name in parentheses.
        expect(isPtyUsageScanCommand('(sysctl)')).toBe(true);
        expect(isPtyUsageScanCommand('/usr/sbin/lsof -i :3000')).toBe(false);
    });
});
