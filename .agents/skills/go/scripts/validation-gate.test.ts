import { describe, expect, it } from 'vitest';

import { createRunBudget } from './run-budget';
import { completeValidation, startValidation } from './validation-gate';

function validationState() {
    return { runBudget: createRunBudget(), validations: [] };
}

function start(state: ReturnType<typeof validationState>, headSha = 'head-1') {
    return startValidation(state, {
        command: 'bun run typecheck',
        headSha,
        kind: 'gates',
        lineageId: 'typecheck-failure',
        logPath: 'validation/typecheck.log',
        sessionId: `session-${state.validations.length + 1}`,
    });
}

describe('Go validation gate', () => {
    it('persists command, session, log, and final exit code', () => {
        const state = validationState();
        const validation = start(state);
        completeValidation(state, { exitCode: 1, id: validation.id });

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
        completeValidation(state, { exitCode: 0, id: validation.id });
        expect(() => start(state)).toThrow('passed exact-head validation cannot be rerun');
        expect(() =>
            startValidation(state, {
                command: 'bun run typecheck',
                headSha: 'head-1',
                kind: 'gates',
                lineageId: 'renamed-lineage',
                logPath: 'validation/typecheck-renamed.log',
                sessionId: 'session-renamed',
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
            completeValidation(state, { exitCode: 1, id: validation.id });
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
            }),
        ).toThrow('Validation logs must stay under');
    });
});
