import { describe, expect, it } from 'vitest';

import {
    assertFullSuiteAuthorized,
    fullSuiteRefusalMessage,
    isFullSuiteAuthorized,
    isFullSuiteInvocation,
} from '../full-suite-authorization.ts';

describe('full suite authorization', () => {
    it('treats a bare runner invocation as the full gate', () => {
        expect(isFullSuiteInvocation('unit', ['run'])).toBe(true);
        expect(isFullSuiteInvocation('e2e', ['test'])).toBe(true);
        expect(isFullSuiteInvocation('unit', ['run', '--reporter=json'])).toBe(true);
        expect(isFullSuiteInvocation('unit', [])).toBe(true);
    });

    /**
     * A flag written with a separate value used to leave that value looking like a positional filter, which waved the
     * whole suite through. These are the forms the repository and both runners actually produce.
     */
    it.each([
        ['unit', ['run', '--reporter', 'json']],
        ['unit', ['run', '--root', '../..']],
        ['unit', ['run', '--outputFile', '.vitest/json/output.json']],
        ['e2e', ['test', '--workers', '1']],
        ['e2e', ['test', '--max-failures', '1']],
        ['e2e', ['test', '--add-reporter', 'json']],
        ['e2e', ['test', '--reporter', 'line']],
    ] as const)(
        'still sees the full %s gate behind a separated flag value (%j)',
        (runner, argv) => {
            expect(isFullSuiteInvocation(runner, argv)).toBe(true);
        },
    );

    it.each([
        ['unit', ['run', 'packages/protocol']],
        ['unit', ['run', '-t', 'long paste']],
        ['unit', ['run', '--changed']],
        ['unit', ['run', '--root', '../..', '--project', 'protocol']],
        ['unit', ['run', '--project=desktop-parallel']],
        ['e2e', ['test', 'e2e/settings.e2e.ts']],
        ['e2e', ['test', '--grep', 'Settings']],
        ['e2e', ['test', '--grep=Settings']],
        ['e2e', ['test', '--shard', '1/3']],
        ['e2e', ['test', '--ui']],
    ] as const)('leaves a narrowed %s run alone (%j)', (runner, argv) => {
        expect(isFullSuiteInvocation(runner, argv)).toBe(false);
    });

    it('authorizes CI and an explicit opt-in, and nothing else', () => {
        expect(isFullSuiteAuthorized({ CI: 'true' })).toBe(true);
        expect(isFullSuiteAuthorized({ CAXRI_FULL_SUITE_AUTHORIZED: '1' })).toBe(true);
        expect(isFullSuiteAuthorized({})).toBe(false);
        expect(isFullSuiteAuthorized({ GITHUB_ACTIONS: 'true' })).toBe(false);
        expect(isFullSuiteAuthorized({ CAXRI_FULL_SUITE_REVIEW_RECEIPT: '/tmp/review.json' })).toBe(
            false,
        );
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

    it('describes distinct remote policies for full unit and E2E gates', () => {
        expect(() => assertFullSuiteAuthorized('unit', ['run'], {})).toThrow(
            /main pushes run the full unit gate/u,
        );
        expect(() => assertFullSuiteAuthorized('e2e', ['test'], {})).toThrow(
            /maintainer-authorized hosted-full dispatch/u,
        );
        expect(fullSuiteRefusalMessage('e2e')).not.toContain('every pushed head');
    });

    it('stays out of the way of a focused or authorized run', () => {
        expect(() =>
            assertFullSuiteAuthorized('unit', ['run', 'packages/protocol'], {}),
        ).not.toThrow();
        expect(() => assertFullSuiteAuthorized('unit', ['run'], { CI: 'true' })).not.toThrow();
    });
});
