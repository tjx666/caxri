import type { ASTNode, MarkdownParser } from '@ronradtke/react-native-markdown-display';
import { parser } from '@ronradtke/react-native-markdown-display';
import MarkdownIt from 'markdown-it';

/**
 * The parser every reply renders with. The library defaults its `markdownit` prop inline, so every render built a new
 * parser; one module constant keeps it stable. It keeps the library's default typographer and adds `linkify`, the way
 * Desktop's Chat parses replies, so a bare `https://` URL becomes a link while a bare domain stays text.
 *
 * It is built on the workspace's markdown-it rather than the library's `createMarkdownIt`: that bundles markdown-it 14,
 * whose linkify links bare domains and runs a URL on into the CJK text after it (`https://example.com/a。下一句`).
 */
const markdownIt = new MarkdownIt({ linkify: true, typographer: true });

/**
 * Markdown-it 15 types an attribute value as `string | number`, while the library's token shape says `string`. The only
 * numeric value is an ordered list's `start`, which the library already reads through `Number(...)`.
 */
export const MARKDOWN_IT: MarkdownParser = {
    parse: (value, environment) =>
        markdownIt.parse(value, environment) as ReturnType<MarkdownParser['parse']>,
};

/**
 * The library's own parse (the one `Markdown` runs on a string), kept so the reply can mark its fading text nodes
 * before handing the tree back.
 */
export const parseMarkdown = (text: string): ASTNode[] => {
    let nodes: ASTNode[] = [];
    void parser(
        text,
        (parsed) => {
            nodes = parsed;
            return null;
        },
        MARKDOWN_IT,
    );
    return nodes;
};
