const CJK_PROSE_CHARACTER_PATTERN =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LEADING_WRAPPERS = new Set(['(', '[', '{', '<', '"', "'", '`', '（', '【', '「', '『', '《']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`']);

export type TerminalLinkClosingBracket = ')' | ']' | '}';

export const TERMINAL_LINK_BRACKET_ADJUSTMENTS: Partial<
    Record<string, readonly [TerminalLinkClosingBracket, number]>
> = {
    '(': [')', -1],
    ')': [')', 1],
    '[': [']', -1],
    ']': [']', 1],
    '{': ['}', -1],
    '}': ['}', 1],
};

export interface TrimmedTerminalLinkToken {
    endOffset: number;
    startOffset: number;
    text: string;
}

/**
 * Preserves balanced URL/path brackets, but stops at the first unmatched closer so adjacent wrapper prose stays out.
 */
export function trimTerminalLinkToken(raw: string): TrimmedTerminalLinkToken {
    let startOffset = 0;
    let endOffset = raw.length;
    while (startOffset < endOffset && LEADING_WRAPPERS.has(raw[startOffset])) startOffset += 1;
    const bracketExcess: Record<TerminalLinkClosingBracket, number> = {
        ')': 0,
        ']': 0,
        '}': 0,
    };
    for (let index = startOffset; index < endOffset; index += 1) {
        const adjustment = TERMINAL_LINK_BRACKET_ADJUSTMENTS[raw[index]];
        if (!adjustment) continue;
        const [closer, delta] = adjustment;
        if (delta > 0 && bracketExcess[closer] === 0) {
            endOffset = index;
            break;
        }
        bracketExcess[closer] += delta;
    }
    while (startOffset < endOffset && TRAILING_PUNCTUATION.has(raw[endOffset - 1])) endOffset -= 1;
    return { endOffset, startOffset, text: raw.slice(startOffset, endOffset) };
}

/**
 * Agent prose often appends an unspaced CJK note such as `(覆盖 …)` after a URL. Only an unmatched opener is a prose
 * boundary: balanced brackets remain valid URL characters, and this plain-text-only pass must not narrow OSC 8
 * targets.
 */
export function trimPlainTextUrlToken(raw: string): TrimmedTerminalLinkToken {
    const trimmed = trimTerminalLinkToken(raw);
    const unmatchedOpeners: Record<TerminalLinkClosingBracket, number[]> = {
        ')': [],
        ']': [],
        '}': [],
    };
    for (let index = trimmed.startOffset; index < trimmed.endOffset; index += 1) {
        const adjustment = TERMINAL_LINK_BRACKET_ADJUSTMENTS[raw[index]];
        if (!adjustment) continue;
        const [closer, delta] = adjustment;
        if (delta < 0) unmatchedOpeners[closer].push(index);
        else unmatchedOpeners[closer].pop();
    }
    let endOffset = trimmed.endOffset;
    for (const indices of Object.values(unmatchedOpeners)) {
        for (const index of indices) {
            const nextCodePoint = raw.codePointAt(index + 1);
            if (
                nextCodePoint !== undefined &&
                CJK_PROSE_CHARACTER_PATTERN.test(String.fromCodePoint(nextCodePoint))
            )
                endOffset = Math.min(endOffset, index);
        }
    }
    while (trimmed.startOffset < endOffset && TRAILING_PUNCTUATION.has(raw[endOffset - 1]))
        endOffset -= 1;
    return {
        endOffset,
        startOffset: trimmed.startOffset,
        text: raw.slice(trimmed.startOffset, endOffset),
    };
}
