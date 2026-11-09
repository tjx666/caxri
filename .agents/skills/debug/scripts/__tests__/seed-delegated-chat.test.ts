import { describe, expect, it } from 'vitest';

import { parseSeedArguments } from '../seed-delegated-chat';

describe('seed-delegated-chat', () => {
    it('reads the profile and an optional host Session', () => {
        expect(parseSeedArguments(['--user-data-dir', '/tmp/task/profile'])).toEqual({
            userData: '/tmp/task/profile',
        });
        expect(
            parseSeedArguments(['--user-data-dir', '/tmp/task/profile', '--session', 'session-1']),
        ).toEqual({ sessionId: 'session-1', userData: '/tmp/task/profile' });
    });

    it('refuses a missing or relative profile and unknown arguments', () => {
        expect(() => parseSeedArguments([])).toThrow(/--user-data-dir/u);
        expect(() => parseSeedArguments(['--user-data-dir', 'profile'])).toThrow(
            /--user-data-dir/u,
        );
        expect(() => parseSeedArguments(['--user-data-dir'])).toThrow(/needs a value/u);
        expect(() => parseSeedArguments(['--host', 'x'])).toThrow(/Unknown argument/u);
    });
});
