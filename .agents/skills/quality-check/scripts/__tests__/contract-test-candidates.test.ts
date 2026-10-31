import { describe, expect, it } from 'vitest';

import { contractTestCandidates } from '../contract-test-candidates';

const ATOMIC_WRITE_CONTRACT = 'scripts/__tests__/atomic-write-contract.test.ts';

describe('atomic-write contract selection', () => {
    it('selects the contract for a changed or removed tooling script', () => {
        expect(contractTestCandidates(['scripts/build-alerter.ts'], [])).toContain(
            ATOMIC_WRITE_CONTRACT,
        );
        expect(
            contractTestCandidates([], ['.agents/skills/switch-worktree/scripts/repo.ts']),
        ).toContain(ATOMIC_WRITE_CONTRACT);
    });

    it('skips tests and paths the contract does not scan', () => {
        expect(
            contractTestCandidates(
                [
                    'scripts/__tests__/install-script.test.ts',
                    '.agents/skills/debug/SKILL.md',
                    'apps/server/src/index.ts',
                ],
                [],
            ),
        ).not.toContain(ATOMIC_WRITE_CONTRACT);
    });
});
