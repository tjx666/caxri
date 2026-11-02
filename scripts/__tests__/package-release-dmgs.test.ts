import { describe, expect, it } from 'vitest';

import {
    assertReleaseSignature,
    assertSourceMapInventory,
    releaseDmgArtifact,
    releaseSigningExpectation,
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
        const unsigned = {
            appRequirement: 'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"\n',
            shareExtensionDisplay: 'Identifier=com.caxri.app.share\nSignature=adhoc\n',
            shareExtensionEntitlements,
        };
        expect(() => assertReleaseSignature({ appDisplay, ...unsigned })).not.toThrow();
        // The bare arm64 Electron build that Gatekeeper reports as "damaged".
        expect(() =>
            assertReleaseSignature({
                ...unsigned,
                appDisplay: 'Identifier=Electron\nSignature=adhoc\nSealed Resources=none\n',
            }),
        ).toThrow('Caxri.app is not signed with its own bundle identifier.');
        expect(() =>
            assertReleaseSignature({
                ...unsigned,
                appDisplay: 'Identifier=com.caxri.app\nSealed Resources=none\n',
            }),
        ).toThrow('Caxri.app signature does not seal its resources.');
        expect(() =>
            assertReleaseSignature({
                ...unsigned,
                appDisplay,
                shareExtensionEntitlements: '<plist><dict/></plist>',
            }),
        ).toThrow('Caxri Share.appex lost its sandbox entitlement during signing.');
    });

    it('requires the release certificate on the app, the Share extension, and the designated requirement', () => {
        const signing = {
            certificateSha1: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
            identity: 'Caxri Release',
        };
        const signedDisplay =
            'Identifier=com.caxri.app\nAuthority=Caxri Release\nSealed Resources version=2 rules=13 files=10\n';
        const signed = {
            appDisplay: signedDisplay,
            appRequirement:
                'designated => identifier "com.caxri.app" and certificate leaf = H"abcdef0123456789abcdef0123456789abcdef01"\n',
            shareExtensionDisplay: 'Identifier=com.caxri.app.share\nAuthority=Caxri Release\n',
            shareExtensionEntitlements:
                '<plist><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>',
            signing,
        };
        expect(() => assertReleaseSignature(signed)).not.toThrow();
        // An ad-hoc build where the release workflow expected the certificate.
        expect(() =>
            assertReleaseSignature({
                ...signed,
                appDisplay:
                    'Identifier=com.caxri.app\nSignature=adhoc\nSealed Resources version=2\n',
            }),
        ).toThrow('Caxri.app is not signed by Caxri Release.');
        expect(() =>
            assertReleaseSignature({
                ...signed,
                shareExtensionDisplay: 'Identifier=com.caxri.app.share\nSignature=adhoc\n',
            }),
        ).toThrow('Caxri Share.appex is not signed by Caxri Release.');
        // Signed by a different certificate: updates would drop every user's privacy grants.
        expect(() =>
            assertReleaseSignature({
                ...signed,
                appRequirement:
                    'designated => identifier "com.caxri.app" and certificate leaf = H"1111111111111111111111111111111111111111"\n',
            }),
        ).toThrow('designated requirement does not pin the release certificate');
    });

    it('fails a release package that lost its signing identity instead of shipping ad-hoc', () => {
        expect(releaseSigningExpectation({})).toBeUndefined();
        expect(
            releaseSigningExpectation({
                CAXRI_MAC_SIGNING_CERT_SHA1: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
                CAXRI_MAC_SIGNING_IDENTITY: 'Caxri Release',
                CAXRI_REQUIRE_MAC_SIGNING: '1',
            }),
        ).toEqual({
            certificateSha1: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
            identity: 'Caxri Release',
        });
        expect(() => releaseSigningExpectation({ CAXRI_REQUIRE_MAC_SIGNING: '1' })).toThrow(
            'no signing identity was imported',
        );
        expect(() =>
            releaseSigningExpectation({ CAXRI_MAC_SIGNING_IDENTITY: 'Caxri Release' }),
        ).toThrow('must be set together');
    });
});
