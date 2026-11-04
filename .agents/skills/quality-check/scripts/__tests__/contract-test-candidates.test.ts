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

const LOGGING_CONTRACT = 'scripts/__tests__/logging-contract.test.ts';

describe('logging contract selection', () => {
    it('selects the contract for a changed production source', () => {
        expect(
            contractTestCandidates(['apps/server/src/domains/agents/lifecycle-projection.ts'], []),
        ).toContain(LOGGING_CONTRACT);
        expect(
            contractTestCandidates(['apps/desktop/src/renderer/components/app.tsx'], []),
        ).toContain(LOGGING_CONTRACT);
    });

    it('skips tests and paths outside the scanned sources', () => {
        expect(
            contractTestCandidates(
                [
                    'apps/server/src/domains/agents/__tests__/lifecycle.test.ts',
                    'apps/server/src/domains/agents/lifecycle.test.ts',
                    'e2e/agent-delegation.e2e.ts',
                    'scripts/build-alerter.ts',
                    'apps/server/package.json',
                ],
                [],
            ),
        ).not.toContain(LOGGING_CONTRACT);
    });
});
