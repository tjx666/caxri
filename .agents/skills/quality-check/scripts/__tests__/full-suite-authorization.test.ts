import { describe, expect, it } from 'vitest';

import {
    assertFullSuiteAuthorized,
    isFullSuiteAuthorized,
    isFullSuiteInvocation,
} from '../full-suite-authorization.ts';

describe('full suite authorization', () => {
    it('treats a bare runner invocation as the full gate', () => {
        expect(isFullSuiteInvocation('unit', ['run'])).toBe(true);
        expect(isFullSuiteInvocation('e2e', ['test'])).toBe(true);
        expect(isFullSuiteInvocation('unit', ['run', '--reporter=json'])).toBe(true);
    });

    it.each([
        ['unit', ['run', 'packages/protocol']],
        ['unit', ['run', '-t', 'long paste']],
        ['unit', ['run', '--changed']],
        ['e2e', ['test', 'e2e/settings.e2e.ts']],
        ['e2e', ['test', '--grep', 'Settings']],
        ['e2e', ['test', '--grep=Settings']],
        ['e2e', ['test', '--shard', '1/3']],
    ] as const)('leaves a narrowed %s run alone (%j)', (runner, argv) => {
        expect(isFullSuiteInvocation(runner, argv)).toBe(false);
    });

    it('authorizes CI and an explicit opt-in, and nothing else', () => {
        expect(isFullSuiteAuthorized({ CI: 'true' })).toBe(true);
        expect(isFullSuiteAuthorized({ CAXRI_FULL_SUITE_AUTHORIZED: '1' })).toBe(true);
        expect(isFullSuiteAuthorized({})).toBe(false);
        expect(isFullSuiteAuthorized({ GITHUB_ACTIONS: 'true' })).toBe(false);
    });

    it('names the wrong operation and the narrower command in its refusal', () => {
        expect(() => assertFullSuiteAuthorized('e2e', ['test'], {})).toThrow(
            /Refusing to run the full Electron E2E suite locally/u,
        );
        expect(() => assertFullSuiteAuthorized('e2e', ['test'], {})).toThrow(
            /CAXRI_FULL_SUITE_AUTHORIZED=1/u,
        );
        expect(() => assertFullSuiteAuthorized('unit', ['run'], {})).toThrow(/bun run check/u);
    });

    it('stays out of the way of a focused or authorized run', () => {
        expect(() =>
            assertFullSuiteAuthorized('unit', ['run', 'packages/protocol'], {}),
        ).not.toThrow();
        expect(() => assertFullSuiteAuthorized('unit', ['run'], { CI: 'true' })).not.toThrow();
    });
});
