import type { SessionRelation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { DELEGATION_SUMMARY_INSTRUCTION, delegationTaskBody } from '../task-body';

const database = (relation?: SessionRelation) =>
    ({
        getSession: () => ({ createdByRelation: relation }),
    }) as unknown as Parameters<typeof delegationTaskBody>[0];
const record = (frozenInstructions?: string) => ({
    frozenInstructions,
    input: {
        projectId: 'project',
        sessionId: 'session',
        provider: 'claude' as const,
        prompt: 'Check the retry design.',
    },
});

describe('delegationTaskBody', () => {
    it.each(['delegated', 'consult'] as const)(
        'asks a task of a %s Session for the closing Summary line, after instructions and prompt',
        (relation) => {
            expect(delegationTaskBody(database(relation), record('Be brief.'))).toBe(
                `Be brief.\n\nCheck the retry design.\n\n${DELEGATION_SUMMARY_INSTRUCTION}`,
            );
            expect(delegationTaskBody(database(relation), record())).toBe(
                `Check the retry design.\n\n${DELEGATION_SUMMARY_INSTRUCTION}`,
            );
        },
    );

    it.each([undefined, 'handoff' as const])(
        'leaves the body as it was in a Session whose result is never stored (%s)',
        (relation) => {
            expect(delegationTaskBody(database(relation), record('Be brief.'))).toBe(
                'Be brief.\n\nCheck the retry design.',
            );
        },
    );

    it('leaves the body alone when the Session is gone', () => {
        const missing = { getSession: () => {} } as unknown as Parameters<
            typeof delegationTaskBody
        >[0];

        expect(delegationTaskBody(missing, record())).toBe('Check the retry design.');
    });

    it('words the instruction as one line with the label the summary reader looks for', () => {
        expect(DELEGATION_SUMMARY_INSTRUCTION).toBe(
            'When you finish, end your final answer with one line: `Summary: <one sentence, at most 200 characters, on what you did or found>`.',
        );
        expect(DELEGATION_SUMMARY_INSTRUCTION).not.toContain('\n');
    });
});
