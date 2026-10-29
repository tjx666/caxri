import { describe, expect, it } from 'vitest';

import { MemoCache } from './memo-cache';

describe('MemoCache', () => {
    it('returns what it stored', () => {
        const cache = new MemoCache(2, 1000);
        cache.set('a', 'first');

        expect(cache.get('a')).toBe('first');
        expect(cache.get('missing')).toBeUndefined();
    });

    it('evicts the least recently used entry once it is over capacity', () => {
        const cache = new MemoCache(2, 1000);
        cache.set('a', 'first');
        cache.set('b', 'second');
        cache.set('c', 'third');

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('second');
        expect(cache.get('c')).toBe('third');
        expect(cache.size).toBe(2);
    });

    it('keeps an entry a re-render read again', () => {
        const cache = new MemoCache(2, 1000);
        cache.set('a', 'first');
        cache.set('b', 'second');
        cache.get('a');
        cache.set('c', 'third');

        expect(cache.get('a')).toBe('first');
        expect(cache.get('b')).toBeUndefined();
    });

    it('overwrites a key without growing', () => {
        const cache = new MemoCache(2, 1000);
        cache.set('a', 'first');
        cache.set('a', 'replacement');

        expect(cache.get('a')).toBe('replacement');
        expect(cache.size).toBe(1);
    });

    it('drops everything when the theme it was rendered against changes', () => {
        const cache = new MemoCache(2, 1000);
        cache.set('a', 'first');
        cache.clear();

        expect(cache.size).toBe(0);
        expect(cache.get('a')).toBeUndefined();
    });

    it('evicts the least recently used entries once their characters exceed the budget', () => {
        const cache = new MemoCache(10, 12);
        cache.set('a', 'xxxxx');
        cache.set('b', 'yyyyy');
        cache.get('a');
        cache.set('c', 'zzzzz');

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe('xxxxx');
        expect(cache.get('c')).toBe('zzzzz');
        expect(cache.characters).toBe(12);
    });

    it('does not store an entry larger than the whole budget', () => {
        const cache = new MemoCache(10, 4);
        cache.set('a', 'xx');
        cache.set('b', 'yyyyyyyy');

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe('xx');
        expect(cache.characters).toBe(3);
    });

    it('frees the characters of an overwritten or cleared entry', () => {
        const cache = new MemoCache(10, 100);
        cache.set('a', 'long value');
        cache.set('a', 'v');

        expect(cache.characters).toBe(2);
        cache.clear();
        expect(cache.characters).toBe(0);
    });
});
