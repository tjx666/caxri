import { describe, expect, it } from 'vitest';

import { findDmgPair, parseArguments } from '../install-caxri';

describe('install-caxri', () => {
    it('parses an optional release tag and rejects unknown arguments', () => {
        expect(parseArguments([])).toEqual({});
        expect(parseArguments(['--tag', 'v0.0.7'])).toEqual({ tag: 'v0.0.7' });
        expect(() => parseArguments(['--nope'])).toThrow('Unknown argument');
        expect(() => parseArguments(['--tag'])).toThrow('Unknown argument');
    });

    it('pairs the downloaded DMG with its checksum companion', () => {
        expect(findDmgPair(['Caxri-0.0.7-arm64.dmg', 'Caxri-0.0.7-arm64.dmg.sha256'])).toEqual({
            checksum: 'Caxri-0.0.7-arm64.dmg.sha256',
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
        expect(findDmgPair(['Caxri-0.0.7-arm64.dmg'])).toEqual({
            checksum: undefined,
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
        expect(findDmgPair(['README.md'])).toBeUndefined();
    });
});
