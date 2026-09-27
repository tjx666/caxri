import { describe, expect, it } from 'vitest';

import { CommandError } from './process';
import type { CdpPortProbe } from './worktree-cdp-port';
import {
    CDP_PORT_BASE,
    CDP_PORT_RANGE,
    derivePreferredCdpPort,
    explicitCdpPort,
    resolveWorktreeCdpPort,
} from './worktree-cdp-port';

/**
 * A probe that reports every port unavailable except those in `freePorts`, so a test can force conflicts without
 * binding real sockets.
 */
function fakeProbe(freePorts: Iterable<number>): CdpPortProbe {
    const free = new Set(freePorts);
    return { isAvailable: (port) => Promise.resolve(free.has(port)) };
}

describe('derivePreferredCdpPort', () => {
    it('reproduces the same port for the same worktree identity', () => {
        const identity = '5b0a6050-2a8c-4175-be3a-edef83ca548b';
        expect(derivePreferredCdpPort(identity)).toBe(derivePreferredCdpPort(identity));
    });

    it('stays within the reserved CDP port range', () => {
        for (const identity of ['a', 'b', 'c', 'worktree-1', 'worktree-2']) {
            const port = derivePreferredCdpPort(identity);
            expect(port).toBeGreaterThanOrEqual(CDP_PORT_BASE);
            expect(port).toBeLessThan(CDP_PORT_BASE + CDP_PORT_RANGE);
        }
    });

    it('gives two different identities different preferred ports (no accidental collision for these fixtures)', () => {
        const a = derivePreferredCdpPort('worktree-alpha');
        const b = derivePreferredCdpPort('worktree-beta');
        expect(a).not.toBe(b);
    });
});

describe('resolveWorktreeCdpPort', () => {
    it('picks the deterministic preferred port when it is free', async () => {
        const identity = 'stable-identity';
        const preferred = derivePreferredCdpPort(identity);
        const port = await resolveWorktreeCdpPort(identity, fakeProbe([preferred]));
        expect(port).toBe(preferred);
    });

    it('advances to the next port in range when the preferred one is occupied', async () => {
        const identity = 'busy-identity';
        const preferred = derivePreferredCdpPort(identity);
        const fallback = CDP_PORT_BASE + ((preferred - CDP_PORT_BASE + 1) % CDP_PORT_RANGE);
        const port = await resolveWorktreeCdpPort(identity, fakeProbe([fallback]));
        expect(port).toBe(fallback);
        expect(port).not.toBe(preferred);
    });

    it('gives two worktrees whose preferred port collides two distinct live ports', async () => {
        // A shared "occupied" set models the real scenario the repository lock protects against:
        // both worktrees resolve against the same live view of what is currently bound, and the
        // second resolution must not repeat the first's port even though both prefer it.
        const occupied = new Set<number>();
        const probe: CdpPortProbe = {
            isAvailable: (port) => Promise.resolve(!occupied.has(port)),
        };
        const identityA = 'collision-a';
        const identityB = 'collision-b';

        const portA = await resolveWorktreeCdpPort(identityA, probe);
        occupied.add(portA);
        // identityB is not guaranteed to hash to the same preferred port as identityA, so mark that
        // preferred port occupied too, forcing identityB through the same advance-on-conflict path.
        occupied.add(derivePreferredCdpPort(identityB));

        const portB = await resolveWorktreeCdpPort(identityB, probe);
        expect(portB).not.toBe(portA);
        expect(occupied.has(portB)).toBe(false);
    });

    it('throws when every port in the range is occupied', async () => {
        await expect(resolveWorktreeCdpPort('any-identity', fakeProbe([]))).rejects.toThrow(
            CommandError,
        );
    });
});

describe('explicitCdpPort', () => {
    it('returns undefined when CAXRI_DEV_CDP_PORT is unset', () => {
        expect(explicitCdpPort({})).toBeUndefined();
    });

    it('returns undefined when CAXRI_DEV_CDP_PORT is exported but empty', () => {
        expect(explicitCdpPort({ CAXRI_DEV_CDP_PORT: '' })).toBeUndefined();
    });

    it('parses a valid explicit port', () => {
        expect(explicitCdpPort({ CAXRI_DEV_CDP_PORT: '9233' })).toBe(9233);
    });

    it('throws CommandError for a non-numeric value', () => {
        expect(() => explicitCdpPort({ CAXRI_DEV_CDP_PORT: 'nope' })).toThrow(CommandError);
    });

    it('throws CommandError for a non-positive value', () => {
        expect(() => explicitCdpPort({ CAXRI_DEV_CDP_PORT: '0' })).toThrow(CommandError);
        expect(() => explicitCdpPort({ CAXRI_DEV_CDP_PORT: '-1' })).toThrow(CommandError);
    });
});
