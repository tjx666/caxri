import type { ASTNode } from '@ronradtke/react-native-markdown-display';
import { describe, expect, it, vi } from 'vitest';

import { parseMarkdown } from '../conversation-markdown-parser';
import {
    isQuoteWorthCopying,
    QUOTE_COPY_MIN_CHARACTERS,
    quoteIndexOf,
    quoteNodeText,
    quotePlainText,
} from '../conversation-quote-text';

/**
 * The package entry pulls in React Native, which Node cannot load; its parser modules are plain JavaScript.
 */
vi.mock('@ronradtke/react-native-markdown-display', async () => ({
    parser: (await import('@ronradtke/react-native-markdown-display/dist/lib/view/parser.js'))
        .default,
}));

const quoteIndexes = (nodes: ASTNode[]): Array<number | undefined> =>
    nodes.flatMap((node) => [
        ...(node.type === 'blockquote' ? [quoteIndexOf(node)] : []),
        ...quoteIndexes(node.children),
    ]);

/**
 * What tapping Copy on every rendered quote of `source` copies, in the order the quotes render.
 */
const copiedQuotes = (source: string): string[] =>
    quoteIndexes(parseMarkdown(source)).map((index) => quotePlainText(source, index ?? -1));

describe('conversation quote text', () => {
    it('copies a quoted draft without its markers, keeping its line breaks', () => {
        expect(
            copiedQuotes('可以这样回他：\n\n> 不是跨人去重。\n> 这次主要修的是画布。\n\n结束。'),
        ).toEqual(['不是跨人去重。\n这次主要修的是画布。']);
    });

    it('copies each quote of a reply as its own text', () => {
        expect(copiedQuotes('> first **draft**\n\ntext\n\n> second\n>\n> - one\n> - two')).toEqual([
            'first draft',
            'second\n\n- one\n- two',
        ]);
    });

    it('finds quotes nested in another quote or inside a list item', () => {
        expect(copiedQuotes('> outer\n>\n> > inner\n\n10. item\n\n    > in a list\n')).toEqual([
            'outer\n\ninner',
            'inner',
            'in a list',
        ]);
    });
});

describe('quote Copy threshold', () => {
    const quoteTexts = (source: string) =>
        parseMarkdown(source).flatMap(function find(node): string[] {
            return node.type === 'blockquote' ? [quoteNodeText(node)] : node.children.flatMap(find);
        });

    it('keeps Copy off a short single-line quote', () => {
        expect(quoteTexts('> A short phrase.').map(isQuoteWorthCopying)).toEqual([false]);
    });

    it('offers Copy on a multi-line quote', () => {
        expect(quoteTexts('> first line\n> second line').map(isQuoteWorthCopying)).toEqual([true]);
        expect(quoteTexts('> one paragraph\n>\n> another').map(isQuoteWorthCopying)).toEqual([
            true,
        ]);
    });

    it('offers Copy on a long single line only past the threshold', () => {
        expect(isQuoteWorthCopying('x'.repeat(QUOTE_COPY_MIN_CHARACTERS))).toBe(false);
        expect(isQuoteWorthCopying('x'.repeat(QUOTE_COPY_MIN_CHARACTERS + 1))).toBe(true);
    });
});
