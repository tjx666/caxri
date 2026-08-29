import { describe, expect, it } from 'vitest';

import { createInitialState, validateState } from '../state-model';

describe('Go schema v9 migration', () => {
    it('preserves pending validation recovery and upgrades degraded checkpoints', () => {
        const current = createInitialState({ objective: 'Resume v9', runId: 'legacy-v9' });
        const legacy = {
            ...current,
            phase: 'issue_execution',
            runBudget: {
                checkpoints: [
                    {
                        commitCount: 1,
                        elapsedSeconds: 'unavailable',
                        fileCount: 2,
                        fullReviewCount: 0,
                        hardThresholdReached: false,
                        phase: 'issue_execution',
                        recordedAt: current.createdAt,
                        tokens: 'unavailable',
                        validationRepairCount: 0,
                    },
                ],
                policy: current.runBudget.policy,
                routedWork: [],
            },
            schemaVersion: 9,
            status: 'active',
            validations: [
                {
                    attempt: 1,
                    command: 'bun run typecheck',
                    completedAt: null,
                    exitCode: null,
                    headSha: 'legacy-head',
                    id: 'validation-001',
                    kind: 'gates',
                    lineageId: 'legacy-lineage',
                    logPath: 'validation/typecheck.log',
                    result: 'pending',
                    sessionId: 'legacy-session',
                    startedAt: current.createdAt,
                },
            ],
        } as Record<string, unknown>;
        Reflect.deleteProperty(legacy, 'mutationLease');

        const migrated = validateState(legacy);
        expect(migrated).toMatchObject({
            mutationLease: { holderId: 'validation-001', kind: 'validation' },
            schemaVersion: 12,
        });
        expect(migrated.runBudget.checkpoints[0]).toMatchObject({
            elapsedSeconds: 0,
            tokenTelemetry: 'degraded',
            validationAttemptCount: 1,
        });
        expect(migrated.validations[0]).toMatchObject({
            artifactVersion: 0,
            integrityError: null,
            sourceFingerprint: 'legacy-unavailable',
            termination: null,
        });
    });
});
