import type { ASTNode } from '@ronradtke/react-native-markdown-display';
import { describe, expect, it, vi } from 'vitest';

import { parseMarkdown } from '../conversation-markdown-parser';

/**
 * The package entry pulls in React Native, which Node cannot load; its parser modules are plain JavaScript.
 */
vi.mock('@ronradtke/react-native-markdown-display', async () => ({
    parser: (await import('@ronradtke/react-native-markdown-display/dist/lib/view/parser.js'))
        .default,
}));

const links = (nodes: ASTNode[]): Array<{ href: unknown; text: string }> =>
    nodes.flatMap((node) =>
        node.type === 'link'
            ? [
                  {
                      href: node.attributes.href,
                      text: node.children.map((child) => child.content).join(''),
                  },
              ]
            : links(node.children),
    );

describe('conversation markdown parser', () => {
    it('links a bare URL in a reply and leaves the CJK punctuation after it as text', () => {
        expect(links(parseMarkdown('主页是 https://github.com/octocat ，显示名叫 Mona。'))).toEqual(
            [{ href: 'https://github.com/octocat', text: 'https://github.com/octocat' }],
        );
        expect(links(parseMarkdown('见https://example.com/a。下一句'))).toEqual([
            { href: 'https://example.com/a', text: 'https://example.com/a' },
        ]);
    });

    it('keeps bare domains and URLs inside code as text', () => {
        expect(links(parseMarkdown('Open example.com or `https://example.com`.'))).toEqual([]);
        expect(links(parseMarkdown('```\nhttps://example.com\n```'))).toEqual([]);
    });
});
