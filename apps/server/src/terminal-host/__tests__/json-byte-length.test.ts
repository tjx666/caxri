import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { isJsonWithinByteLimit } from '../json-byte-length';

/**
 * The reference the structural check replaced; every case asserts the two agree exactly at the boundary.
 */
function referenceByteLength(value: unknown): number | undefined {
    try {
        const json = JSON.stringify(value) as string | undefined;
        return json === undefined ? undefined : Buffer.byteLength(json, 'utf8');
    } catch {
        return undefined;
    }
}

function expectSameBoundary(value: unknown): void {
    const size = referenceByteLength(value);
    if (size === undefined) {
        expect(isJsonWithinByteLimit(value, Number.MAX_SAFE_INTEGER)).toBe(false);
        return;
    }
    expect(isJsonWithinByteLimit(value, size)).toBe(true);
    expect(isJsonWithinByteLimit(value, size - 1)).toBe(false);
}

class Point {
    constructor(
        readonly x: number,
        readonly y: number,
    ) {}
}

describe('isJsonWithinByteLimit', () => {
    it('matches JSON.stringify for strings that need escaping or multi-byte UTF-8', () => {
        for (const text of [
            '',
            'plain ascii',
            'quote " and backslash \\',
            '\b\t\n\f\r',
            '\u{0}\u{1}\u{1B}[31mred\u{1B}[0m\u{7F}',
            'café ÿ Ā ߿ ࠀ',
            '中文 ￿',
            '😀 emoji pair',
            'lone high \u{D800} surrogate',
            'lone low \u{DC00} surrogate',
            'trailing high \u{D83D}',
            '\u{2028}\u{2029}',
        ])
            expectSameBoundary(text);
    });

    it('matches JSON.stringify for nested plain data', () => {
        expectSameBoundary({
            type: 'event',
            event: 'terminal.output',
            terminalId: 't-1',
            data: 'line\r\n\u{1B}[0m',
            sequence: 42,
            ratio: -0.125,
            huge: 1e21,
            tiny: 5e-7,
            negativeZero: -0,
            flags: [true, false, null],
            nested: { empty: {}, list: [], deep: [[[{ a: 'b' }]]] },
        });
        expectSameBoundary([1, 'two', { three: 3 }, [], {}]);
        expectSameBoundary(Object.assign(Object.create(null) as object, { key: 'value' }));
        expectSameBoundary({ 'kéy "quoted"': '中' });
    });

    it('matches JSON.stringify for omitted members, null array holes, and non-finite numbers', () => {
        expectSameBoundary({
            a: undefined,
            b: () => 1,
            c: Symbol('s'),
            d: 1,
            e: NaN,
            f: Infinity,
        });
        expectSameBoundary({ onlyOmitted: undefined });
        expectSameBoundary([undefined, () => 1, Symbol('s'), NaN]);
        // eslint-disable-next-line no-sparse-arrays -- A hole serializes as null like an undefined element.
        expectSameBoundary([1, , 3]);
    });

    it('falls back to JSON.stringify for values with custom serialization', () => {
        expectSameBoundary({ at: new Date(0) });
        expectSameBoundary({ custom: { toJSON: () => ({ replaced: 'yes' }) } });
        expectSameBoundary({ dropped: { toJSON: () => {} } });
        expectSameBoundary([{ toJSON: () => {} }]);
        expectSameBoundary({ point: new Point(1, 2) });
        expectSameBoundary({ bytes: new Uint8Array([1, 2, 3]) });
        expectSameBoundary({ buffer: Buffer.from('abc') });
        expectSameBoundary({ map: new Map([['a', 1]]) });
        // eslint-disable-next-line unicorn/new-for-builtins -- Boxed primitives serialize unwrapped.
        expectSameBoundary({ boxed: new String('boxed'), count: new Number(3) });
    });

    it('rejects what JSON.stringify cannot serialize', () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        expect(isJsonWithinByteLimit(cyclic, Number.MAX_SAFE_INTEGER)).toBe(false);
        const cyclicThroughClass = { holder: new Point(0, 0) as Point & { back?: unknown } };
        cyclicThroughClass.holder.back = cyclicThroughClass;
        expect(isJsonWithinByteLimit(cyclicThroughClass, Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isJsonWithinByteLimit({ n: 1n }, Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isJsonWithinByteLimit(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(isJsonWithinByteLimit(() => 1, Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    it('counts a shared, non-cyclic reference once per occurrence like JSON.stringify', () => {
        const shared = { text: 'shared' };
        expectSameBoundary({ first: shared, second: shared, list: [shared, shared] });
    });

    it('agrees with JSON.stringify on randomized protocol-like messages', () => {
        let seed = 7;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        const alphabet = ['a', 'Z', ' ', '"', '\\', '\n', '\u{1B}', 'é', '中', '😀', '\u{D800}'];
        const randomString = () =>
            Array.from(
                { length: Math.floor(random() * 40) },
                () => alphabet[Math.floor(random() * alphabet.length)],
            ).join('');
        const randomValue = (depth: number): unknown => {
            const pick = Math.floor(random() * (depth > 3 ? 4 : 7));
            if (pick === 0) return randomString();
            if (pick === 1) return Math.round((random() - 0.5) * 1e6) / 1e3;
            if (pick === 2) return random() > 0.5;
            if (pick === 3) return null;
            if (pick === 4)
                return Array.from({ length: Math.floor(random() * 4) }, () =>
                    randomValue(depth + 1),
                );
            if (pick === 5) return undefined;
            const object: Record<string, unknown> = {};
            for (let member = Math.floor(random() * 4); member > 0; member -= 1)
                object[randomString()] = randomValue(depth + 1);
            return object;
        };
        for (let index = 0; index < 500; index += 1) expectSameBoundary({ root: randomValue(0) });
    });

    it('stops scanning once a large string passes the limit', () => {
        const limit = 1024;
        expect(isJsonWithinByteLimit({ data: 'x'.repeat(limit) }, limit)).toBe(false);
        expect(isJsonWithinByteLimit({ data: '中'.repeat(400) }, limit)).toBe(false);
        expect(isJsonWithinByteLimit({ data: 'x'.repeat(limit - 11) }, limit)).toBe(true);
    });
    it('accepts an ordinary message from the O(1) upper bound in a single pass', () => {
        let reads = 0;
        const message = {
            get data() {
                reads += 1;
                return '\u{1B}[0m'.repeat(10_000);
            },
        };
        expect(isJsonWithinByteLimit(message, 32 * 1024 * 1024)).toBe(true);
        expect(reads).toBe(1);
    });
});
