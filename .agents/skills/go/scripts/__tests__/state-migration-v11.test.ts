import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createInitialState, validateState } from '../state-model';

describe('Go schema v11 migration', () => {
    it('removes persisted argv while retaining a secret-free command identity', () => {
        const current = createInitialState({ objective: 'Resume v11', runId: 'legacy-v11' });
        const token = `github_pat_${'a'.repeat(20)}`;
        const arguments_ = ['-H', `Authorization: Bearer ${token}`, 'https://example.test'];
        const commandDigest = createHash('sha256')
            .update(JSON.stringify(['curl', ...arguments_]))
            .digest('hex');
        const legacy = {
            ...current,
            schemaVersion: 11,
            validations: [
                {
                    argumentCount: 0,
                    arguments: arguments_,
                    artifactVersion: 1,
                    attempt: 1,
                    childPid: null,
                    command: `curl -H "Authorization: Bearer ${token}" https://example.test`,
                    completedAt: current.createdAt,
                    durationMs: 1,
                    executable: 'curl',
                    exitCode: 1,
                    headSha: 'legacy-head',
                    id: 'validation-001',
                    integrityError: null,
                    kind: 'fixture',
                    lineageId: 'legacy-lineage',
                    logByteLength: null,
                    logError: 'legacy failure',
                    logIntegrityError: null,
                    logMetadata: null,
                    logPath: 'validation/validation-001.log',
                    logSha256: null,
                    result: 'failed',
                    runnerPid: null,
                    sessionId: 'legacy-session',
                    signal: null,
                    sourceFingerprint: 'legacy-fingerprint',
                    startedAt: current.createdAt,
                    termination: 'runner_error',
                },
            ],
        };

        const migrated = validateState(legacy);
        const serialized = JSON.stringify(migrated);

        expect(migrated.schemaVersion).toBe(12);
        expect(migrated.validations[0]).toMatchObject({
            argumentCount: 3,
            arguments: [],
            command: `curl (3 args; sha256:${commandDigest.slice(0, 12)})`,
            commandDigest,
        });
        expect(serialized).not.toContain(token);
    });
});
