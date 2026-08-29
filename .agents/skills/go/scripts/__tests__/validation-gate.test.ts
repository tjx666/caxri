import { describe, expect, it } from 'vitest';

import { createRunBudget } from '../run-budget';
import { completeValidation, recordValidationChildPid, startValidation } from '../validation-gate';

function validationState() {
    return { mutationLease: null, runBudget: createRunBudget(), validations: [] };
}

function start(state: ReturnType<typeof validationState>, headSha = 'head-1') {
    return startValidation(state, {
        command: 'bun run typecheck',
        headSha,
        kind: 'gates',
        lineageId: 'typecheck-failure',
        logPath: 'validation/typecheck.log',
        sessionId: `session-${state.validations.length + 1}`,
        sourceFingerprint: `fingerprint-${headSha}`,
    });
}

function complete(
    state: ReturnType<typeof validationState>,
    validation: ReturnType<typeof start>,
    exitCode: number,
) {
    return completeValidation(state, {
        clean: true,
        exitCode,
        headSha: validation.headSha,
        id: validation.id,
        sourceFingerprint: validation.sourceFingerprint,
    });
}

describe('Go validation gate', () => {
    it('persists command, session, log, and final exit code', () => {
        const state = validationState();
        const validation = start(state);
        complete(state, validation, 1);

        expect(validation).toMatchObject({
            command: 'bun run typecheck',
            exitCode: 1,
            logPath: 'validation/typecheck.log',
            result: 'failed',
            sessionId: 'session-1',
        });
    });

    it('recovers pending work before rerun and never repeats a passed exact-head gate', () => {
        const state = validationState();
        const validation = start(state);
        expect(() => start(state)).toThrow('still pending');
        complete(state, validation, 0);
        expect(() => start(state)).toThrow('passed exact-head validation cannot be rerun');
        expect(() =>
            startValidation(state, {
                command: 'bun run typecheck',
                headSha: 'head-1',
                kind: 'gates',
                lineageId: 'renamed-lineage',
                logPath: 'validation/typecheck-renamed.log',
                sessionId: 'session-renamed',
                sourceFingerprint: 'fingerprint-head-1',
            }),
        ).toThrow('passed exact-head validation cannot be rerun');
        expect(() => start(state, 'head-2')).not.toThrow();
    });

    it('stops after the configured repair budget for one failure lineage', () => {
        const state = validationState();
        for (
            let attempt = 0;
            attempt < state.runBudget.policy.validationRepairLimit;
            attempt += 1
        ) {
            const validation = start(state, `head-${attempt + 1}`);
            complete(state, validation, 1);
        }
        expect(() => start(state, 'head-4')).toThrow('repair budget exhausted');
    });

    it('keeps validation logs inside the run artifact layout', () => {
        const state = validationState();
        expect(() =>
            startValidation(state, {
                command: 'bun run test',
                headSha: 'head-1',
                kind: 'gates',
                lineageId: 'unsafe-path',
                logPath: '../../transcript.jsonl',
                sessionId: 'session-unsafe',
                sourceFingerprint: 'fingerprint-head-1',
            }),
        ).toThrow('Validation logs must stay under');
        expect(state.mutationLease).toBeNull();
    });

    it('fails closed when HEAD or source state changes and releases the validation lease', () => {
        const state = validationState();
        const validation = start(state);
        const completed = completeValidation(state, {
            clean: false,
            exitCode: 0,
            headSha: 'replacement-head',
            id: validation.id,
            sourceFingerprint: 'changed-fingerprint',
        });

        expect(completed.integrityError).toContain('HEAD changed');
        expect(completed.result).toBe('failed');
        expect(state.mutationLease).toBeNull();
    });

    it('stops the lineage durably after the final failed repair attempt', () => {
        const state = validationState();
        for (
            let attempt = 1;
            attempt <= state.runBudget.policy.validationRepairLimit;
            attempt += 1
        ) {
            const validation = start(state, `head-${attempt}`);
            complete(state, validation, 1);
        }

        expect(state.runBudget.repairStops).toEqual([
            expect.objectContaining({ lineageId: 'typecheck-failure' }),
        ]);
    });

    it('requires a complete managed log receipt before passing', () => {
        const state = validationState();
        const validation = startValidation(state, {
            arguments: ['run', 'typecheck'],
            artifactVersion: 1,
            command: 'bun run typecheck',
            executable: 'bun',
            headSha: 'head-1',
            kind: 'gates',
            lineageId: 'managed-typecheck',
            runnerPid: 100,
            sourceFingerprint: 'fingerprint-head-1',
        });
        recordValidationChildPid(state, validation.id, 100, 101);

        const completed = completeValidation(state, {
            clean: true,
            durationMs: 25,
            exitCode: 0,
            headSha: validation.headSha,
            id: validation.id,
            logByteLength: 42,
            logMetadata: { ctimeMs: 1, device: 1, inode: 1, mtimeMs: 1 },
            logSha256: 'a'.repeat(64),
            sourceFingerprint: validation.sourceFingerprint,
            termination: 'exit',
        });

        expect(completed).toMatchObject({
            childPid: 101,
            durationMs: 25,
            result: 'passed',
            termination: 'exit',
        });
    });

    it('does not charge caller interruption or runner loss against the repair budget', () => {
        const state = validationState();
        for (const [index, termination] of (
            ['caller_interrupt', 'runner_lost'] as const
        ).entries()) {
            const validation = startValidation(state, {
                arguments: ['run', 'typecheck'],
                artifactVersion: 1,
                command: 'bun run typecheck',
                executable: 'bun',
                headSha: `head-${index + 1}`,
                kind: 'gates',
                lineageId: 'interrupted-typecheck',
                runnerPid: 100 + index,
                sourceFingerprint: `fingerprint-head-${index + 1}`,
            });
            expect(validation.attempt).toBe(1);
            completeValidation(state, {
                clean: true,
                exitCode: null,
                headSha: validation.headSha,
                id: validation.id,
                logError: 'fixture interruption',
                signal: termination === 'caller_interrupt' ? 'SIGINT' : null,
                sourceFingerprint: validation.sourceFingerprint,
                termination,
            });
        }
        expect(state.runBudget.repairStops).toEqual([]);
    });
});
