import { describe, expect, it } from 'vitest';

import { createSecretOutputMasker } from '../secret-output-masker';

function run(values: Record<string, string>, chunks: string[]): string {
    const masker = createSecretOutputMasker(values);
    return chunks.map((chunk) => masker.push(chunk)).join('') + masker.flush();
}

describe('createSecretOutputMasker', () => {
    it('replaces a value with its placeholder', () => {
        expect(run({ ALPHA: 'hm-abcdef123' }, ['val=hm-abcdef123\n'])).toBe('val=[secret:ALPHA]\n');
    });

    it('replaces a value split across chunks', () => {
        expect(run({ ALPHA: 'hm-abcdef123' }, ['val=hm-ab', 'cdef', '123 done'])).toBe(
            'val=[secret:ALPHA] done',
        );
    });

    it('releases a partial prefix that never completes', () => {
        expect(run({ ALPHA: 'hm-abcdef123' }, ['hm-abc', ' nope'])).toBe('hm-abc nope');
    });

    it('prefers the longest value when one contains another', () => {
        expect(run({ SHORT: 'abcd1234', LONG: 'abcd1234xyz' }, ['abcd1234xyz'])).toBe(
            '[secret:LONG]',
        );
    });

    it('does not mask values shorter than the minimum length', () => {
        expect(run({ PIN: 'abc' }, ['abc abc'])).toBe('abc abc');
    });

    it('emits text that cannot start a value without waiting', () => {
        const masker = createSecretOutputMasker({ ALPHA: 'hm-abcdef123' });
        expect(masker.push('hello ')).toBe('hello ');
        expect(masker.pending()).toBe(false);
        expect(masker.push('hm-')).toBe('');
        expect(masker.pending()).toBe(true);
        expect(masker.flush()).toBe('hm-');
    });
});
