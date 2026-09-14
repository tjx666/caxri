import type { BigIntStats } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fileIdentity } from '../file-identity';

const base = {
    ctimeNs: 1_788_580_529_659_183_087n,
    dev: 1n,
    ino: 2n,
    mode: 0o100_644n,
    mtimeNs: 1_788_580_529_659_183_087n,
    size: 64n,
} as BigIntStats;

describe('fileIdentity', () => {
    it('separates revisions that differ only below one millisecond', () => {
        const sameMillisecond = {
            ...base,
            ctimeNs: base.ctimeNs + 1_000n,
            mtimeNs: base.mtimeNs + 1_000n,
        };
        expect(fileIdentity(sameMillisecond)).not.toBe(fileIdentity(base));
        expect(fileIdentity({ ...base })).toBe(fileIdentity(base));
    });

    /**
     * Each field is here because some real substitution changes only that one. Asserting them together rather than one
     * per case keeps the list itself the subject: a field quietly dropped from the join is what this has to catch.
     */
    it.each([
        ['a path repointed at another file on the same device', { ino: 3n }],
        ['the same inode number on a different device', { dev: 2n }],
        ['a rewrite that kept the timestamps', { size: 65n }],
        ['a permission change', { mode: 0o100_600n }],
    ])('separates %s', (_description, difference) => {
        expect(fileIdentity({ ...base, ...difference })).not.toBe(fileIdentity(base));
    });
});
