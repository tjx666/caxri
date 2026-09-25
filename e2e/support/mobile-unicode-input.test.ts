import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { mobileUnicodeInputArguments } from './mobile-unicode-input';

describe('mobile Unicode input arguments', () => {
    it.each(['testAssertComposerFocused', 'testAssertUnknownFeedback'] as const)(
        'omits empty text arguments for %s',
        (method) => {
            const arguments_ = mobileUnicodeInputArguments('emulator-5554', method);

            expect(arguments_).not.toContain('-e');
            expect(arguments_).not.toContain('');
            expect(arguments_.at(-1)).toContain(`#${method}`);
        },
    );

    it.each(['testSetUnicodeText', 'testAssertDraft'] as const)(
        'encodes fixture text for %s',
        (method) => {
            const arguments_ = mobileUnicodeInputArguments('emulator-5554', method, '示例\ntext');

            expect(arguments_.slice(-3)).toEqual([
                '-e',
                'textBase64',
                Buffer.from('示例\ntext', 'utf8').toString('base64'),
            ]);
        },
    );

    it('rejects a missing fixture for a text action', () => {
        expect(() => mobileUnicodeInputArguments('emulator-5554', 'testAssertDraft')).toThrow(
            'Unicode fixture text is required',
        );
    });
});
