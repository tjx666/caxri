import { describe, expect, it } from 'vitest';

import { createInitialState, validateState } from '../state-model';

describe('Go schema v10 migration', () => {
    it('preserves historical results without claiming a managed log receipt', () => {
        const current = createInitialState({ objective: 'Resume v10', runId: 'legacy-v10' });
        const legacy = {
            ...current,
            schemaVersion: 10,
            validations: [
                {
                    attempt: 1,
                    command: 'bun run typecheck',
                    completedAt: current.createdAt,
                    exitCode: 0,
                    headSha: 'legacy-head',
                    id: 'validation-001',
                    integrityError: null,
                    kind: 'gates',
                    lineageId: 'legacy-lineage',
                    logPath: 'validation/typecheck.log',
                    result: 'passed',
                    sessionId: 'legacy-session',
                    sourceFingerprint: 'legacy-fingerprint',
                    startedAt: current.createdAt,
                },
            ],
        } as Record<string, unknown>;

        const migrated = validateState(legacy);

        expect(migrated.schemaVersion).toBe(12);
        expect(migrated.validations[0]).toMatchObject({
            arguments: [],
            artifactVersion: 0,
            executable: null,
            logByteLength: null,
            logMetadata: null,
            logSha256: null,
            result: 'passed',
            termination: 'legacy',
        });
        expect(migrated.validations[0].commandDigest).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('rejects a managed result that contradicts its process receipt', () => {
        const state = createInitialState({
            objective: 'Reject forged result',
            runId: 'result-v11',
        });
        state.validations.push({
            argumentCount: 2,
            arguments: [],
            artifactVersion: 1,
            attempt: 1,
            childPid: 101,
            childIdentity: null,
            command: 'bun run typecheck',
            commandDigest: null,
            completedAt: state.createdAt,
            durationMs: 12,
            executable: 'bun',
            exitCode: 9,
            headSha: 'head-1',
            id: 'validation-001',
            integrityError: null,
            kind: 'gates',
            lineageId: 'forged-result',
            logByteLength: 10,
            logError: null,
            logIntegrityError: null,
            logMetadata: { ctimeMs: 1, device: 1, inode: 1, mtimeMs: 1 },
            logPath: 'validation/validation-001.log',
            logSha256: 'a'.repeat(64),
            result: 'passed',
            runnerPid: 100,
            runnerIdentity: null,
            sessionId: 'fixture',
            signal: null,
            sourceFingerprint: 'fingerprint',
            startedAt: state.createdAt,
            termination: 'exit',
        });

        expect(() => validateState(state)).toThrow('result contradicts its receipt');
    });
});
