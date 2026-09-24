import { describe, expect, it } from 'vitest';

import { mobileSessionCreateResultSchema } from '../mobile/mobile-contract.js';

describe('mobile Session creation result', () => {
    it('contains only navigation IDs and a bounded safe launch error', () => {
        expect(
            mobileSessionCreateResultSchema.parse({
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                launchError: {
                    code: 'TERMINAL_START_FAILED',
                    message: 'Terminal failed to start',
                },
            }),
        ).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            launchError: {
                code: 'TERMINAL_START_FAILED',
                message: 'Terminal failed to start',
            },
        });
        expect(
            mobileSessionCreateResultSchema.safeParse({
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                cwd: 'private-directory',
            }).success,
        ).toBe(false);
        expect(
            mobileSessionCreateResultSchema.safeParse({
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                launchError: {
                    code: 'TERMINAL_START_FAILED',
                    message: 'x'.repeat(257),
                },
            }).success,
        ).toBe(false);
    });
});
