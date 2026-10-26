import type { ASTNode } from '@ronradtke/react-native-markdown-display';
import { describe, expect, it } from 'vitest';

import {
    colorWithOpacity,
    FADING_TEXT_NODE,
    fadingText,
    fadingTextOf,
    isConversationTextFading,
    markdownTextNodes,
    nextConversationTextReveal,
    withFadingTextNodes,
} from '../conversation-text-reveal';

const node = (type: string, content = '', children: ASTNode[] = []): ASTNode => ({
    type,
    sourceType: type,
    sourceInfo: null,
    sourceMeta: null,
    block: false,
    key: `${type}-${content}`,
    content,
    markup: '',
    tokenIndex: 0,
    index: 0,
    attributes: {},
    children,
});

const paragraphs = (...texts: string[]): ASTNode[] =>
    texts.map((text) => node('paragraph', '', [node('textgroup', '', [node('text', text)])]));

describe('conversation text reveal', () => {
    it('shows the text a reply mounted with at once and fades in what arrives later', () => {
        let reveal = nextConversationTextReveal(undefined, ['Hello'], 1_000, 1_000);
        expect(isConversationTextFading(reveal, 1_000)).toBe(false);
        reveal = nextConversationTextReveal(reveal, ['Hello, wo'], 1_200, 1_000);
        reveal = nextConversationTextReveal(reveal, ['Hello, world'], 1_450, 1_000);
        expect(fadingText(reveal[0], 1_450)).toEqual({
            settledEnd: 5,
            runs: [
                { start: 5, end: 9, opacity: 0.5 },
                { start: 9, end: 12, opacity: 0 },
            ],
        });
    });

    it('settles a run once its fade completes, and stops fading after the last one', () => {
        let reveal = nextConversationTextReveal(undefined, ['ab'], 0, 0);
        reveal = nextConversationTextReveal(reveal, ['abcd'], 1_000, 0);
        reveal = nextConversationTextReveal(reveal, ['abcdef'], 1_300, 0);
        expect(fadingText(reveal[0], 1_600)).toEqual({
            settledEnd: 4,
            runs: [{ start: 4, end: 6, opacity: 0.6 }],
        });
        expect(isConversationTextFading(reveal, 1_799)).toBe(true);
        expect(isConversationTextFading(reveal, 1_800)).toBe(false);
    });

    it('fades in the whole of a text node that appears after the mount grace', () => {
        let reveal = nextConversationTextReveal(undefined, ['First'], 0, 0);
        reveal = nextConversationTextReveal(reveal, ['First', 'Second'], 2_000, 0);
        expect(fadingText(reveal[0], 2_000).runs).toEqual([]);
        expect(fadingText(reveal[1], 2_000).runs).toEqual([{ start: 0, end: 6, opacity: 0 }]);
    });

    it('returns the previous reveal while the text nodes keep their text', () => {
        const reveal = nextConversationTextReveal(undefined, ['a', 'b'], 0, 0);
        expect(nextConversationTextReveal(reveal, ['a', 'b'], 50, 0)).toBe(reveal);
        expect(nextConversationTextReveal(reveal, ['a'], 50, 0)).toHaveLength(1);
    });

    it('marks only the text nodes still fading, sharing the rest of the tree', () => {
        const nodes = paragraphs('Settled', 'New');
        expect(markdownTextNodes(nodes).map((text) => text.content)).toEqual(['Settled', 'New']);
        let reveal = nextConversationTextReveal(undefined, ['Settled'], 0, 0);
        reveal = nextConversationTextReveal(reveal, ['Settled', 'New'], 1_000, 0);
        const marked = withFadingTextNodes(nodes, reveal, 1_100);
        expect(marked[0]).toBe(nodes[0]);
        const [textgroup] = marked[1].children;
        const [fading] = textgroup.children;
        expect(fading.type).toBe(FADING_TEXT_NODE);
        expect(fadingTextOf(fading)).toEqual({
            settledEnd: 0,
            runs: [{ start: 0, end: 3, opacity: 0.2 }],
        });
        expect(withFadingTextNodes(nodes, reveal, 1_500)).toBe(nodes);
    });

    it('blends a hex color with the run opacity and leaves other colors opaque', () => {
        expect(colorWithOpacity('#f8f8f2', 0.25)).toBe('rgba(248, 248, 242, 0.25)');
        expect(colorWithOpacity('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
        expect(colorWithOpacity('red', 0.5)).toBe('red');
    });
});
