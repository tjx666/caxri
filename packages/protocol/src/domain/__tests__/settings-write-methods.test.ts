import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';

/**
 * An Agent's `business:write` grant carries `settings.write` so it can apply an allowlisted Settings patch. Any other
 * method gated by that capability must be owner-only, or the grant would reach authority its patch allowlist excludes
 * (for example `claudeWindow.tick`, which can send a model request on the user's Claude account).
 */
const agentReachableSettingsWriteMethods = new Set(['settings.patch']);

describe('settings.write methods', () => {
    it('keeps every settings.write method except the Settings patch owner-only', () => {
        const open = Object.entries(methods)
            .filter(([name]) => !agentReachableSettingsWriteMethods.has(name))
            .filter(([, spec]) =>
                (spec as { requiredCapabilities: readonly string[] }).requiredCapabilities.includes(
                    'settings.write',
                ),
            )
            .filter(([, spec]) => (spec as { principal?: 'owner' }).principal !== 'owner')
            .map(([name]) => name);
        expect(open).toEqual([]);
    });

    it('declares the Claude window keeper methods owner-only', () => {
        expect(methods['claudeWindow.update']).toMatchObject({ principal: 'owner' });
        expect(methods['claudeWindow.tick']).toMatchObject({ principal: 'owner' });
    });
});
