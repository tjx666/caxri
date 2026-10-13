import { describe, expect, it } from 'vitest';

import type { StartupBundle } from '../host-startup-budget';
import { hostStartupBudget, measureStartupJavaScript } from '../host-startup-budget';

const bundle: StartupBundle = {
    'extension-host.js': {
        code: 'e'.repeat(100),
        imports: ['shared.js', 'node:fs'],
        type: 'chunk',
    },
    'lazy.js': { code: 'l'.repeat(5000), imports: [], type: 'chunk' },
    'runtime.js': { code: 'r'.repeat(10), imports: ['shared.js'], type: 'chunk' },
    'shared.js': { code: 's'.repeat(300), imports: ['runtime.js'], type: 'chunk' },
    'shared.js.map': { type: 'asset' },
};

function generate(budgets: Record<string, number>): void {
    const hook = hostStartupBudget(budgets).generateBundle as (
        options: unknown,
        output: StartupBundle,
    ) => void;
    hook({}, bundle);
}

describe('host startup budget', () => {
    it('sums the entry and its transitive static imports once each', () => {
        expect(measureStartupJavaScript(bundle, 'extension-host.js')).toEqual({
            bytes: 410,
            chunks: [
                { bytes: 300, fileName: 'shared.js' },
                { bytes: 100, fileName: 'extension-host.js' },
                { bytes: 10, fileName: 'runtime.js' },
            ],
        });
    });

    it('fails the build over budget and names the loaded chunks', () => {
        expect(() => generate({ 'extension-host': 410 })).not.toThrow();
        expect(() => generate({ 'extension-host': 409 })).toThrow(
            /extension-host loads 0 KiB of JavaScript at startup.*shared\.js 0 KiB, extension-host\.js 0 KiB, runtime\.js 0 KiB/,
        );
    });

    it('fails when a budget names an entry the bundle does not emit', () => {
        expect(() => generate({ 'terminal-host': 1024 })).toThrow(
            'terminal-host.js is not a chunk of this bundle',
        );
    });
});
