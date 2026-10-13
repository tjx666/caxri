import { describe, expect, it } from 'vitest';

import { assertSourceMapInventory, releaseDmgArtifact } from '../package-release-dmgs';

describe('package-release-dmgs', () => {
    it('uses isolated output directories and stable public asset names', () => {
        expect(releaseDmgArtifact('/repo', '1.2.3', 'include')).toMatchObject({
            appPath: '/repo/release.noindex/sourcemap/mac-arm64/Caxri.app',
            assetName: 'Caxri-1.2.3-arm64.dmg',
            checksumPath: '/repo/release.noindex/sourcemap/Caxri-1.2.3-arm64.dmg.sha256',
            dmgPath: '/repo/release.noindex/sourcemap/Caxri-1.2.3-arm64.dmg',
        });
        expect(releaseDmgArtifact('/repo', '1.2.3', 'omit')).toMatchObject({
            appPath: '/repo/release.noindex/nosourcemap/mac-arm64/Caxri.app',
            assetName: 'Caxri-1.2.3-arm64-nosourcemap.dmg',
            checksumPath:
                '/repo/release.noindex/nosourcemap/Caxri-1.2.3-arm64-nosourcemap.dmg.sha256',
            dmgPath: '/repo/release.noindex/nosourcemap/Caxri-1.2.3-arm64-nosourcemap.dmg',
        });
    });

    it('requires maps in include and rejects any map in omit', () => {
        expect(() =>
            assertSourceMapInventory('fixture', ['index.js.map'], 'include'),
        ).not.toThrow();
        expect(() => assertSourceMapInventory('fixture', [], 'include')).toThrow(
            'fixture contains no Source Maps for the include flavor.',
        );
        expect(() => assertSourceMapInventory('fixture', [], 'omit')).not.toThrow();
        expect(() => assertSourceMapInventory('fixture', ['index.js.map'], 'omit')).toThrow(
            'fixture contains Source Maps for the omit flavor: index.js.map',
        );
    });
});
