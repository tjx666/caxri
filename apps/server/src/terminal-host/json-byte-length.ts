import { Buffer } from 'node:buffer';

/**
 * Allocation-free bound check for IPC messages: `JSON.stringify(value)` measured in UTF-8 bytes, compared with a limit.
 *
 * Server Core and the Terminal Host used to serialize every IPC message they received only to measure it, which
 * allocated a full JSON copy of each Terminal output chunk and snapshot just to throw it away. This walks plain JSON
 * data (objects, arrays, strings, numbers, booleans, null) instead, in up to three passes that differ only in how a
 * string is measured:
 *
 * 1. Upper bound: a string costs at most six bytes per UTF-16 code unit (`\u00XX`), so `6 * length + 2` is O(1). Every
 *    ordinary message is far below the limit and is accepted here without reading any string contents.
 * 2. Lower bound: at least one byte per code unit; a message that exceeds the limit even then is rejected.
 * 3. Exact: only a message near the limit pays for the scan that counts escapes, and it still allocates nothing.
 *
 * Anything with custom serialization (`toJSON`, class instances, boxed primitives, typed arrays, `Map`) falls back to
 * `JSON.stringify` for that sub-value, so the result matches the old check exactly. Getters on plain objects run once
 * per pass; IPC messages are structured-clone data and carry none.
 */

const EXCEEDED = -1;

/**
 * Extra bytes `JSON.stringify` adds over the raw UTF-8 text for each control character: one for the five two-character
 * escapes (\b \t \n \f \r), five for every other `\u00XX` escape.
 */
const CONTROL_ESCAPE_EXTRA = Uint8Array.from({ length: 0x20 }, (_, code) =>
    [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 1 : 5,
);

/**
 * Matches any character whose JSON form differs from its raw UTF-8 bytes: control characters, a quote, a backslash, or
 * a lone surrogate (with the `u` flag a well-formed pair is one code point outside the surrogate range). Non-global, so
 * `test` allocates nothing.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what JSON escapes.
const NEEDS_JSON_ESCAPE = /[\u{0}-\u{1F}"\\\u{D800}-\u{DFFF}]/u;

/**
 * UTF-8 byte length of `JSON.stringify(text)`, including the surrounding quotes, or `EXCEEDED` once it passes `budget`.
 * The UTF-8 length comes from the native `Buffer.byteLength`; only strings containing escapes or surrogates take the
 * JavaScript scan, which adds the escape overhead on top.
 */
function exactStringJsonByteLength(text: string, budget: number): number {
    // Every UTF-16 code unit produces at least one byte, so an oversized string fails before any scan.
    if (text.length + 2 > budget) return EXCEEDED;
    let bytes = Buffer.byteLength(text, 'utf8') + 2;
    if (bytes > budget) return EXCEEDED;
    if (!NEEDS_JSON_ESCAPE.test(text)) return bytes;
    for (let index = 0; index < text.length; index += 1) {
        // eslint-disable-next-line unicorn/prefer-code-point -- JSON escapes per UTF-16 code unit, so scan code units.
        const code = text.charCodeAt(index);
        if (code < 0x20) bytes += CONTROL_ESCAPE_EXTRA[code];
        else if (code === 0x22 || code === 0x5c) bytes += 1;
        else if (code >= 0xd800 && code <= 0xdfff) {
            // eslint-disable-next-line unicorn/prefer-code-point -- Pairing is decided on the raw low surrogate.
            const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
            if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index += 1;
            // A lone surrogate is 3 bytes (U+FFFD) to Buffer.byteLength but a 6-byte \uXXXX escape in JSON.
            else bytes += 3;
        }
    }
    return bytes > budget ? EXCEEDED : bytes;
}

type StringMeasure = (text: string, budget: number) => number;

const upperBoundStringJsonByteLength: StringMeasure = (text, budget) => {
    const bytes = 6 * text.length + 2;
    return bytes > budget ? EXCEEDED : bytes;
};

const lowerBoundStringJsonByteLength: StringMeasure = (text, budget) => {
    const bytes = text.length + 2;
    return bytes > budget ? EXCEEDED : bytes;
};

/**
 * A non-null object reached while walking a value. It may still be exotic (a class instance, boxed primitive, typed
 * array, or `Map`); `isPlainContainer` decides whether the walk can measure it member by member.
 */
type ObjectValue = Record<string, unknown>;

function isPlainContainer(value: ObjectValue): boolean {
    if (Array.isArray(value)) return true;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
}

/**
 * Bytes `JSON.stringify` emits for an exotic value, or `undefined` when it emits nothing (a function, symbol, or
 * `toJSON` returning `undefined`). Throws like `JSON.stringify` on a cycle or a BigInt.
 */
function fallbackJsonByteLength(value: unknown, budget: number): number | undefined {
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) return undefined;
    const bytes = Buffer.byteLength(json, 'utf8');
    return bytes > budget ? EXCEEDED : bytes;
}

/**
 * Returns the serialized byte length of `value`, `undefined` when JSON omits it (object member) or turns it into `null`
 * (array element), or `EXCEEDED`.
 */
function valueJsonByteLength(
    value: unknown,
    budget: number,
    ancestors: object[],
    measureString: StringMeasure,
): number | undefined {
    switch (typeof value) {
        case 'string':
            return measureString(value, budget);
        case 'number':
            return Number.isFinite(value) ? String(value).length : 4;
        case 'boolean':
            return value ? 4 : 5;
        case 'undefined':
        case 'function':
        case 'symbol':
            return undefined;
        case 'bigint':
            throw new TypeError('Do not know how to serialize a BigInt');
        default:
            break;
    }
    if (value === null) return 4;
    const container = value as ObjectValue;
    if (!isPlainContainer(container) || typeof container.toJSON === 'function')
        return fallbackJsonByteLength(container, budget);
    if (ancestors.includes(container)) throw new TypeError('Converting circular structure to JSON');
    ancestors.push(container);
    try {
        if (Array.isArray(container)) {
            // Brackets plus one comma between each pair of elements.
            let bytes = 2 + Math.max(0, container.length - 1);
            if (bytes > budget) return EXCEEDED;
            for (const element of container as unknown[]) {
                const size = valueJsonByteLength(element, budget - bytes, ancestors, measureString);
                if (size === EXCEEDED) return EXCEEDED;
                bytes += size ?? 4;
                if (bytes > budget) return EXCEEDED;
            }
            return bytes;
        }
        let bytes = 2;
        let members = 0;
        // eslint-disable-next-line unicorn/prefer-object-iterable-methods -- entries() would allocate a pair per member.
        for (const key of Object.keys(container)) {
            const size = valueJsonByteLength(
                container[key],
                budget - bytes,
                ancestors,
                measureString,
            );
            if (size === EXCEEDED) return EXCEEDED;
            if (size === undefined) continue;
            const keySize = measureString(key, budget - bytes);
            if (keySize === EXCEEDED) return EXCEEDED;
            // `"key":value`, preceded by a comma after the first member.
            bytes += keySize + 1 + size + (members > 0 ? 1 : 0);
            members += 1;
            if (bytes > budget) return EXCEEDED;
        }
        return bytes;
    } finally {
        ancestors.pop();
    }
}

/**
 * True when `Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit`, and false when it is larger or when
 * `JSON.stringify` would throw or return `undefined`. Never builds the JSON text for plain data.
 */
export function isJsonWithinByteLimit(value: unknown, limit: number): boolean {
    /**
     * A pass reports `EXCEEDED` when it stops early, but a container's own brackets are added without a budget check,
     * so the final total is compared with the limit as well.
     */
    const fits = (measureString: StringMeasure): boolean | undefined => {
        const size = valueJsonByteLength(value, limit, [], measureString);
        return size === undefined ? undefined : size !== EXCEEDED && size <= limit;
    };
    try {
        const upperBoundFits = fits(upperBoundStringJsonByteLength);
        // `undefined` means JSON.stringify returns undefined for this value; every pass would agree.
        if (upperBoundFits === undefined) return false;
        if (upperBoundFits) return true;
        if (!fits(lowerBoundStringJsonByteLength)) return false;
        return fits(exactStringJsonByteLength) === true;
    } catch {
        return false;
    }
}
