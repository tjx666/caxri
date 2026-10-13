import { describe, expect, it } from 'vitest';

import { parseLaunchOutput } from '../remote-launch-output';

describe('parseLaunchOutput', () => {
    it('names the machine that holds the profile', () => {
        expect(() =>
            parseLaunchOutput(
                new Map([
                    ['outcome', 'profile-in-use'],
                    ['holder', 'laptop'],
                ]),
                '',
            ),
        ).toThrow(expect.objectContaining({ reason: 'profileInUse', holder: 'laptop' }));
        expect(() =>
            parseLaunchOutput(
                new Map([
                    ['outcome', 'profile-in-use'],
                    ['holder', ''],
                ]),
                '',
            ),
        ).toThrow(
            expect.objectContaining({ holder: undefined, message: 'In use by another host' }),
        );
    });

    it('rejects a launch that produced no Server or unreadable discovery files', () => {
        expect(() => parseLaunchOutput(undefined, '')).toThrow(
            expect.objectContaining({ reason: 'launchFailed' }),
        );
        expect(() => parseLaunchOutput(new Map([['outcome', 'started']]), '')).toThrow(
            'The remote Server discovery files are invalid',
        );
    });
});
