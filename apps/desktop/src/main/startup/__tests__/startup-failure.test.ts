import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    classifyStartupFailure,
    incompatibleServerChoice,
    startupFailureChoice,
    startupFailureDialog,
} from '../startup-failure';

describe('classifyStartupFailure', () => {
    it.each([
        [new CaxriError('TIMEOUT', 'x'), 'timeout'],
        [new Error('Server did not become ready: timed out'), 'timeout'],
        [new Error('SQLITE_CORRUPT: database disk image is malformed'), 'database'],
        [new Error('Server exited with code 1 before ready'), 'crashed-on-boot'],
        [new Error('socket unavailable'), 'unknown'],
        ['nope', 'unknown'],
    ])('maps %s to %s', (error, reason) => {
        expect(classifyStartupFailure(error)).toBe(reason);
    });
});

describe('recovery dialog choices', () => {
    it('maps start-failure buttons to actions', () => {
        expect(startupFailureChoice(0)).toBe('retry');
        expect(startupFailureChoice(1)).toBe('reveal');
        expect(startupFailureChoice(2)).toBe('quit');
        expect(startupFailureDialog('timeout').buttons).toEqual([
            'Try Again',
            'Reveal Logs in Finder',
            'Quit',
        ]);
    });

    it('maps reset buttons to actions', () => {
        expect(incompatibleServerChoice(0)).toBe('reveal');
        expect(incompatibleServerChoice(1)).toBe('quit');
    });
});
