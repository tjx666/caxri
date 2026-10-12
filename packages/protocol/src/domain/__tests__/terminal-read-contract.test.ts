import { describe, expect, it } from 'vitest';

import { parseServerOperationResult } from '../../transport/transport.js';
import { terminalReadMethods } from '../terminal-read-contract.js';

describe('terminal.runningCount result', () => {
    it('carries running Terminals and Chats as separate counts', () => {
        const running = { terminals: 2, chats: 1 };

        expect(parseServerOperationResult('terminal.runningCount', running)).toEqual(running);
    });

    it.each([
        ['the combined number it used to be', 3],
        ['a missing kind', { terminals: 1 }],
        ['a negative count', { terminals: -1, chats: 0 }],
        ['a fractional count', { terminals: 1.5, chats: 0 }],
        ['an unknown kind', { terminals: 1, chats: 0, shells: 1 }],
    ])('rejects %s', (_case, value) => {
        expect(terminalReadMethods['terminal.runningCount'].result.safeParse(value).success).toBe(
            false,
        );
    });
});
