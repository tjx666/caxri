import { describe, expect, it } from 'vitest';

import {
    assertReleaseSignature,
    assertSourceMapInventory,
    releaseDmgArtifact,
} from '../package-release-dmgs';

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

    it('accepts only a sealed bundle signature that keeps the Share extension sandboxed', () => {
        const appDisplay =
            'Identifier=com.caxri.app\nFormat=app bundle with Mach-O thin (arm64)\nSignature=adhoc\nSealed Resources version=2 rules=13 files=172\n';
        const shareExtensionEntitlements =
            '<plist><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>';
        expect(() =>
            assertReleaseSignature({ appDisplay, shareExtensionEntitlements }),
        ).not.toThrow();
        // The bare arm64 Electron build that Gatekeeper reports as "damaged".
        expect(() =>
            assertReleaseSignature({
                appDisplay: 'Identifier=Electron\nSignature=adhoc\nSealed Resources=none\n',
                shareExtensionEntitlements,
            }),
        ).toThrow('Caxri.app is not signed with its own bundle identifier.');
        expect(() =>
            assertReleaseSignature({
                appDisplay: 'Identifier=com.caxri.app\nSealed Resources=none\n',
                shareExtensionEntitlements,
            }),
        ).toThrow('Caxri.app signature does not seal its resources.');
        expect(() =>
            assertReleaseSignature({
                appDisplay,
                shareExtensionEntitlements: '<plist><dict/></plist>',
            }),
        ).toThrow('Caxri Share.appex lost its sandbox entitlement during signing.');
    });
});
