import { describe, expect, it } from 'vitest';

import { delegatedRedirectMessage, parseDelegatedRedirect } from '../../agent-delegated-task';
import { delegationRedirectParametersSchema, MAX_DELEGATION_REDIRECT_TEXT } from '../redirect';

const base = { delegationId: 'task-1', operationId: 'op-12345', text: 'Use fixtures' };

describe('delegationRedirectParametersSchema', () => {
    it('trims the text and bounds it, the operation ID, and control characters', () => {
        expect(delegationRedirectParametersSchema.parse({ ...base, text: ' hi ' }).text).toBe('hi');
        for (const bad of [
            { text: ' '.repeat(3) },
            { text: 'x'.repeat(MAX_DELEGATION_REDIRECT_TEXT + 1) },
            { text: 'a\u{0}b' },
            { operationId: 'short' },
            { operationId: 'has space 123' },
            { operationId: 'x'.repeat(65) },
        ])
            expect(delegationRedirectParametersSchema.safeParse({ ...base, ...bad }).success).toBe(
                false,
            );
    });
});

describe('redirect message envelope', () => {
    it('round-trips the delegation ID, operation ID, and a multi-line text', () => {
        const text = 'First line\n\nSecond line';

        expect(
            parseDelegatedRedirect(delegatedRedirectMessage('task-1', 'op-12345', text)),
        ).toEqual({
            delegationId: 'task-1',
            operationId: 'op-12345',
            text,
        });
    });

    it('does not read an ordinary message or a task pointer as a redirect', () => {
        expect(parseDelegatedRedirect('Updated direction: please')).toBeUndefined();
        expect(parseDelegatedRedirect('Read the task in a private file.')).toBeUndefined();
    });
});
