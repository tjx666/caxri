import { describe, expect, it } from 'vitest';

import type { XtermRegistryRunner } from '../xterm-beta-line-core';
import { resolveXtermBetaLine } from '../xterm-beta-line-core';

const metadata = {
    '@xterm/addon-image@0.10.0-beta.299': {
        gitHead: 'same-head',
        name: '@xterm/addon-image',
        peerDependencies: { '@xterm/xterm': '^6.1.0-beta.301' },
        version: '0.10.0-beta.299',
    },
    '@xterm/addon-webgl@beta': {
        gitHead: 'same-head',
        name: '@xterm/addon-webgl',
        peerDependencies: { '@xterm/xterm': '^6.1.0-beta.301' },
        version: '0.20.0-beta.298',
    },
    '@xterm/xterm@6.1.0-beta.301': {
        gitHead: 'same-head',
        name: '@xterm/xterm',
        version: '6.1.0-beta.301',
    },
};

function runner(overrides: Record<string, unknown> = {}): XtermRegistryRunner {
    return {
        view(specifier) {
            // Read `metadata` through an honestly-typed lookup (not `as keyof typeof metadata`,
            // which lies that every runtime `specifier` is a known key): an unresolved specifier
            // that also has no override is a real "unexpected query" the test must be able to hit.
            const value = overrides[specifier] ?? (metadata as Record<string, unknown>)[specifier];
            if (!value) throw new Error(`Unexpected registry query: ${specifier}`);
            return Promise.resolve(value);
        },
    };
}

describe('xterm beta line resolver', () => {
    it('resolves addon beta tags to exact same-gitHead versions before installation', async () => {
        await expect(
            resolveXtermBetaLine(
                {
                    dependencies: { '@xterm/addon-image': '0.10.0-beta.299' },
                    devDependencies: { '@xterm/xterm': '6.1.0-beta.301' },
                    resolve: ['@xterm/addon-webgl'],
                },
                runner(),
            ),
        ).resolves.toMatchObject({
            coreVersion: '6.1.0-beta.301',
            gitHead: 'same-head',
            installSpecs: ['@xterm/addon-webgl@0.20.0-beta.298'],
        });
    });

    it('rejects a beta tag published from a different monorepo commit', async () => {
        await expect(
            resolveXtermBetaLine(
                {
                    dependencies: { '@xterm/addon-image': '0.10.0-beta.299' },
                    devDependencies: { '@xterm/xterm': '6.1.0-beta.301' },
                    resolve: ['@xterm/addon-webgl'],
                },
                runner({
                    '@xterm/addon-webgl@beta': {
                        ...metadata['@xterm/addon-webgl@beta'],
                        gitHead: 'different-head',
                    },
                }),
            ),
        ).rejects.toThrow('must share one gitHead');
    });

    it('rejects a same-commit addon whose peer contract targets another core beta', async () => {
        await expect(
            resolveXtermBetaLine(
                {
                    dependencies: { '@xterm/addon-image': '0.10.0-beta.299' },
                    devDependencies: { '@xterm/xterm': '6.1.0-beta.301' },
                    resolve: ['@xterm/addon-webgl'],
                },
                runner({
                    '@xterm/addon-webgl@beta': {
                        ...metadata['@xterm/addon-webgl@beta'],
                        peerDependencies: { '@xterm/xterm': '^6.1.0-beta.302' },
                    },
                }),
            ),
        ).rejects.toThrow('does not bind 6.1.0-beta.301');
    });

    it('rejects non-exact xterm manifest versions', async () => {
        await expect(
            resolveXtermBetaLine(
                {
                    dependencies: {},
                    devDependencies: { '@xterm/xterm': '^6.1.0-beta.301' },
                    resolve: [],
                },
                runner(),
            ),
        ).rejects.toThrow('must use an exact version');
    });
});
