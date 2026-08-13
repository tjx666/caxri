import { readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from './version';

interface PackageManifest {
    bin?: Record<string, string>;
    build?: {
        electronFuses?: { runAsNode?: boolean };
        extraResources?: Array<{ from: string; to: string }>;
    };
    scripts?: Record<string, string>;
    version: string;
}

function readManifest(url: URL): PackageManifest {
    return JSON.parse(readFileSync(url, 'utf8')) as PackageManifest;
}

describe('CLI delivery artifact', () => {
    it('keeps the source version, package version, and root release version aligned', () => {
        const cliPackage = readManifest(new URL('../package.json', import.meta.url));
        const rootPackage = readManifest(new URL('../../../package.json', import.meta.url));

        expect(CLI_VERSION).toBe(cliPackage.version);
        expect(CLI_VERSION).toBe(rootPackage.version);
    });

    it('ships the standalone bundle byte-for-byte inside the Desktop package', () => {
        const cliPackage = readManifest(new URL('../package.json', import.meta.url));
        const rootPackage = readManifest(new URL('../../../package.json', import.meta.url));

        expect(cliPackage.bin).toEqual({ caxri: './dist/caxri.cjs' });
        expect(cliPackage.scripts?.build).toContain('--outfile dist/caxri.cjs');
        expect(cliPackage.scripts?.build).toContain('scripts/verify-bundle.ts');
        expect(rootPackage.build?.extraResources).toContainEqual({
            from: 'packages/cli/dist/caxri.cjs',
            to: 'cli/caxri.cjs',
        });
        expect(rootPackage.build?.electronFuses?.runAsNode).toBe(true);
    });

    it('uses the packaged Electron executable only as a Node runtime', () => {
        const shimUrl = new URL('../../../build/caxri', import.meta.url);
        const shim = readFileSync(shimUrl, 'utf8');

        expect(statSync(shimUrl).mode & 0o111).not.toBe(0);
        expect(shim).toContain('ELECTRON_RUN_AS_NODE=1');
        expect(shim).toContain('../../MacOS/Caxri');
        expect(shim).toContain('../cli/caxri.cjs');
    });
});
