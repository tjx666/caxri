import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { mobileFixtureImeBroadcastArguments } from './mobile-unicode-input';

describe('mobile Unicode input arguments', () => {
    it('sends Unicode only through the test IME on a disposable emulator', () => {
        const value = '示例\ntext';
        const arguments_ = mobileFixtureImeBroadcastArguments('emulator-5554', value);

        expect(arguments_).toEqual([
            '-s',
            'emulator-5554',
            'shell',
            'am',
            'broadcast',
            '-n',
            'caxri.acceptance.ime/.FixtureInsertReceiver',
            '--es',
            'textBase64',
            Buffer.from(value, 'utf8').toString('base64'),
        ]);
        expect(arguments_).not.toContain(value);
        expect(() => mobileFixtureImeBroadcastArguments('192.0.2.1:5555', value)).toThrow(
            'Fixture Unicode input requires a disposable emulator',
        );
    });
});
