import { describe, expect, it } from 'vitest';

import { gitCommandLogLevel } from '../command';

describe('git command log level', () => {
    it.each([
        [{ queueMs: 0, execMs: 40 }, 'debug'],
        [{ queueMs: 249, execMs: 999 }, 'debug'],
        [{ queueMs: 250, execMs: 5 }, 'info'],
        [{ queueMs: 0, execMs: 1000 }, 'info'],
    ] as const)('maps %j to %s', (timing, level) => {
        expect(gitCommandLogLevel(timing)).toBe(level);
    });
});
