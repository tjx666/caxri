import { describe, expect, it } from 'vitest';

import type { E2ETestReceipt } from '../reporters/e2e-receipt-reporter';
import { summarizeE2ETests } from '../reporters/e2e-receipt-reporter';

function receipt(overrides: Partial<E2ETestReceipt> = {}): E2ETestReceipt {
    return {
        artifacts: [],
        errorIdentity: null,
        id: 'suite > case',
        location: 'e2e/example.e2e.ts:1:1',
        title: 'case',
        verdict: 'pass',
        ...overrides,
    };
}

/**
 * `summarizeE2ETests` is reachable production code: `createE2EPoolReceipt` in the same module calls it to derive the
 * `hash` field of every `E2EPoolReceipt` (see `scripts/reporters/e2e-receipt-reporter.ts:135`), and that receipt hash
 * is what `scripts/report-e2e-manifest.ts` and `scripts/run-e2e-pools.ts` persist and compare across CI runs. It is not
 * dead code, but its own identity contract (order- and verdict-independence) was previously only exercised indirectly
 * through `createE2EPoolReceipt` fixtures, so this file tests it directly.
 */
describe('summarizeE2ETests', () => {
    it('is deterministic for the same test list', () => {
        const tests = [receipt({ id: 'a' }), receipt({ id: 'b' })];

        expect(summarizeE2ETests(tests)).toBe(summarizeE2ETests(tests));
    });

    it('is independent of input order', () => {
        const first = receipt({ id: 'a', location: 'e2e/a.e2e.ts:1:1', title: 'a' });
        const second = receipt({ id: 'b', location: 'e2e/b.e2e.ts:1:1', title: 'b' });

        expect(summarizeE2ETests([first, second])).toBe(summarizeE2ETests([second, first]));
    });

    it('does not mutate the input array while sorting', () => {
        const first = receipt({ id: 'b' });
        const second = receipt({ id: 'a' });
        const tests = [first, second];

        summarizeE2ETests(tests);

        expect(tests).toEqual([first, second]);
    });

    it('changes when a test id changes', () => {
        const original = [receipt({ id: 'a' })];
        const renamed = [receipt({ id: 'a-renamed' })];

        expect(summarizeE2ETests(original)).not.toBe(summarizeE2ETests(renamed));
    });

    it('changes when a test location or title changes', () => {
        const baseline = [receipt({ location: 'e2e/example.e2e.ts:1:1', title: 'case' })];
        const movedLocation = [receipt({ location: 'e2e/example.e2e.ts:2:1', title: 'case' })];
        const renamedTitle = [receipt({ location: 'e2e/example.e2e.ts:1:1', title: 'renamed' })];

        expect(summarizeE2ETests(baseline)).not.toBe(summarizeE2ETests(movedLocation));
        expect(summarizeE2ETests(baseline)).not.toBe(summarizeE2ETests(renamedTitle));
    });

    it('ignores fields outside id, location, and title (verdict, artifacts, errorIdentity)', () => {
        const passing = [receipt({ artifacts: [], errorIdentity: null, verdict: 'pass' })];
        const failing = [
            receipt({
                artifacts: ['test-results/example/trace.zip'],
                errorIdentity: 'deadbeef',
                verdict: 'fail',
            }),
        ];

        expect(summarizeE2ETests(passing)).toBe(summarizeE2ETests(failing));
    });

    it('produces a stable hash for an empty test list', () => {
        expect(summarizeE2ETests([])).toBe(summarizeE2ETests([]));
        expect(summarizeE2ETests([])).toMatch(/^[a-f0-9]{64}$/);
    });
});
