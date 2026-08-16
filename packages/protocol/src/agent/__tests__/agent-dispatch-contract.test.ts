import { describe, expect, it } from 'vitest';

import {
    agentDispatchStartParametersSchema,
    agentDispatchWaitParametersSchema,
    MAX_TERMINAL_STEER_BYTES,
    terminalSendParametersSchema,
} from '../agent-dispatch-contract.js';

describe('terminalSendParametersSchema', () => {
    it('allows a plain tab character but rejects other control characters', () => {
        expect(
            terminalSendParametersSchema.safeParse({
                terminalId: 'terminal-1',
                text: 'before\tafter',
            }).success,
        ).toBe(true);
        expect(
            terminalSendParametersSchema.safeParse({
                terminalId: 'terminal-1',
                text: `before${String.fromCodePoint(0x7f)}after`,
            }).success,
        ).toBe(false);
    });

    it('rejects text whose UTF-8 byte length exceeds the steer budget even when the character count is small', () => {
        const multiByteCharacter = '\u{1F600}'; // 4 UTF-8 bytes per character
        const charactersNeeded = Math.floor(MAX_TERMINAL_STEER_BYTES / 4) + 1;
        const oversized = multiByteCharacter.repeat(charactersNeeded);

        expect(
            terminalSendParametersSchema.safeParse({
                terminalId: 'terminal-1',
                text: oversized,
            }).success,
        ).toBe(false);
        expect(
            terminalSendParametersSchema.safeParse({
                terminalId: 'terminal-1',
                text: multiByteCharacter.repeat(charactersNeeded - 1),
            }).success,
        ).toBe(true);
    });

    it('defaults enter to false when omitted', () => {
        const parsed = terminalSendParametersSchema.parse({
            terminalId: 'terminal-1',
            text: 'hello',
        });
        expect(parsed.enter).toBe(false);
    });
});

describe('agentDispatchWaitParametersSchema', () => {
    it('applies default afterRevision and timeoutMs when omitted', () => {
        const parsed = agentDispatchWaitParametersSchema.parse({ dispatchId: 'dispatch-1' });
        expect(parsed.afterRevision).toBe(0);
        expect(parsed.timeoutMs).toBe(15_000);
    });

    it('rejects a timeoutMs outside the bounded window', () => {
        expect(
            agentDispatchWaitParametersSchema.safeParse({
                dispatchId: 'dispatch-1',
                timeoutMs: 99,
            }).success,
        ).toBe(false);
        expect(
            agentDispatchWaitParametersSchema.safeParse({
                dispatchId: 'dispatch-1',
                timeoutMs: 120_001,
            }).success,
        ).toBe(false);
    });
});

describe('agentDispatchStartParametersSchema', () => {
    it('rejects unrecognized fields on the strict dispatch target', () => {
        expect(
            agentDispatchStartParametersSchema.safeParse({
                projectId: 'project-1',
                sessionId: 'session-1',
                provider: 'claude',
                extraneous: 'not allowed',
            }).success,
        ).toBe(false);
    });

    it('accepts a well-formed start request', () => {
        expect(
            agentDispatchStartParametersSchema.safeParse({
                projectId: 'project-1',
                sessionId: 'session-1',
                provider: 'codex',
            }).success,
        ).toBe(true);
    });
});
