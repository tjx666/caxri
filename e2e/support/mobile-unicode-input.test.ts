import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    mobileFixtureImeBroadcastArguments,
    mobileUnicodeInputArguments,
} from './mobile-unicode-input';

describe('mobile Unicode input arguments', () => {
    it.each([
        'testAssertComposerFocused',
        'testFocusComposer',
        'testAssertUnknownFeedback',
    ] as const)('omits empty text arguments for %s', (method) => {
        const arguments_ = mobileUnicodeInputArguments('emulator-5554', method);

        expect(arguments_).not.toContain('-e');
        expect(arguments_).not.toContain('');
        expect(arguments_.at(-1)).toContain(`#${method}`);
    });

    it('encodes fixture text only for the draft assertion', () => {
        const arguments_ = mobileUnicodeInputArguments(
            'emulator-5554',
            'testAssertDraft',
            '示例\ntext',
        );

        expect(arguments_.slice(-3)).toEqual([
            '-e',
            'textBase64',
            Buffer.from('示例\ntext', 'utf8').toString('base64'),
        ]);
    });

    it('rejects a missing fixture for a text action', () => {
        expect(() => mobileUnicodeInputArguments('emulator-5554', 'testAssertDraft')).toThrow(
            'Unicode fixture text is required',
        );
    });

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
