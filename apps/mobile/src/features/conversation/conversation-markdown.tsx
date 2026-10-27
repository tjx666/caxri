import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { TextStyle } from 'react-native';
import { ScrollView, Text, View } from 'react-native';

import type {
    ASTNode,
    MarkdownParser,
    RenderRules,
} from '@ronradtke/react-native-markdown-display';
import Markdown, { createMarkdownIt, parser } from '@ronradtke/react-native-markdown-display';

import { HighlightedCode } from '../../components/highlighted-code';
import { openLink } from '../../lib/open-link';
import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import { fenceLanguage } from '../panels/file-language';
import type { ConversationTextReveal } from './conversation-text-reveal';
import {
    colorWithOpacity,
    FADING_TEXT_NODE,
    fadingTextOf,
    isConversationTextFading,
    markdownTextNodes,
    nextConversationTextReveal,
    TEXT_REVEAL_MAX_LENGTH,
    withFadingTextNodes,
} from './conversation-text-reveal';

/**
 * The library's document-sized headings (32/24/18) dwarf a chat bubble on a phone, so headings step down from a modest
 * top size and lean on weight instead.
 */
const headingStyle = (fontSize: number, color: string) => ({
    color,
    fontSize,
    fontWeight: '600' as const,
    lineHeight: Math.round(fontSize * 1.4),
    marginBottom: 4,
    marginTop: 12,
});

/**
 * The library defaults these props inline (`markdownit = createMarkdownIt()`, a fresh `topLevelMaxExceededItem`
 * element), so every render built a new markdown-it parser and a new AST renderer. Module constants keep both stable;
 * `createMarkdownIt()` with no options is exactly the library's default parser (typographer on, no plugins). The
 * renderer never reaches `topLevelMaxExceededItem` because `maxTopLevelChildren` stays unset.
 */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- The library types the return as markdown-it's class but ships those types only as a devDependency; `MarkdownParser` is the prop's own structural type.
const MARKDOWN_IT: MarkdownParser = createMarkdownIt();
const NO_IMAGE_HANDLERS: string[] = [];

/**
 * How often a reply whose stream paused redraws to carry its last runs' fade to the end, matching the pacer's redraw
 * budget (`use-conversation-paced-text`).
 */
const FADE_REDRAW_MS = 32;

/**
 * The library's own parse (the one `Markdown` runs on a string), kept so the reply can mark its fading text nodes
 * before handing the tree back.
 */
const parseMarkdown = (text: string): ASTNode[] => {
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

/**
 * When a streaming reply's text changed, for `ConversationMarkdown` to fade in what arrived.
 */
export interface ConversationMarkdownReveal {
    /**
     * When the reply's renderer mounted (`performance.now()`): text it mounted with shows at once.
     */
    since: number;
    /**
     * When the current text was shown (`performance.now()`), the arrival time of whatever it added.
     */
    textShownAt: number;
}

/**
 * The tree a reply renders: its plain text, or while it streams in, its parsed tree with the text that just arrived
 * marked to fade in (`fading_text`). Every redraw re-parses the reply and the library mints new keys, so the reveal
 * lives here, by the order of text nodes, rather than in the rendered tree. A paused stream keeps redrawing until its
 * last run is opaque. Times come from the caller and the redraw timer, since a render must not read the clock.
 */
function useRevealingMarkdown(
    text: string,
    reveal: ConversationMarkdownReveal | undefined,
): string | ASTNode[] {
    const isRevealing = reveal !== undefined && text.length <= TEXT_REVEAL_MAX_LENGTH;
    const nodes = useMemo(
        () => (isRevealing ? parseMarkdown(text) : undefined),
        [isRevealing, text],
    );
    const [state, setState] = useState<ConversationTextReveal>();
    const [redrawnAt, setRedrawnAt] = useState(0);
    const now = Math.max(reveal?.textShownAt ?? 0, redrawnAt);
    const current =
        nodes && reveal
            ? nextConversationTextReveal(
                  state,
                  markdownTextNodes(nodes).map((node) => node.content),
                  reveal.textShownAt,
                  reveal.since,
              )
            : undefined;
    // Derived from the previous render, as React documents for state that follows a prop.
    if (current !== state) setState(current);
    const isFading = current !== undefined && isConversationTextFading(current, now);
    useEffect(() => {
        if (!isFading) return;
        // Every render reschedules this, so a stream still delivering redraws on its own and this fires only once it
        // pauses or ends.
        const timer = setTimeout(() => setRedrawnAt(performance.now()), FADE_REDRAW_MS);
        return () => clearTimeout(timer);
    });
    return nodes && current ? withFadingTextNodes(nodes, current, now) : text;
}
const TOP_LEVEL_MAX_EXCEEDED_ITEM = null;

/**
 * A code block in a reply: monospace, selectable, and scrolled sideways rather than wrapped. A known language paints
 * through `HighlightedCode`, which is memoized on the code and language, so a streamed reply re-tokenizes only the
 * block still growing; anything else stays one plain color.
 */
const ConversationCodeBlock = ({
    code,
    language,
    monospace,
    testID,
    theme,
}: {
    code: string;
    language: string | null;
    monospace: string;
    testID: string;
    theme: MobileTheme;
}) => {
    const text = code.replace(/\n$/u, '');
    return (
        <View
            style={{
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                // These rules replace the library's own blocks and their spacing, so back-to-back fences (or a fence
                // under a table) would otherwise share borders and read as one block.
                marginVertical: 8,
            }}
            testID={testID}
        >
            <ScrollView horizontal showsHorizontalScrollIndicator>
                <Text
                    selectable
                    style={{ color: theme.text, fontFamily: monospace, fontSize: 13, padding: 12 }}
                >
                    {language ? <HighlightedCode code={text} language={language} /> : text}
                </Text>
            </ScrollView>
        </View>
    );
};

/**
 * Memoized on the text and theme, so a row redrawn for another reason does not re-parse its reply.
 */
export const ConversationMarkdown = memo(
    ({
        onBeforeOpenLink,
        reveal,
        text,
        theme,
    }: {
        /**
         * Runs before a tapped link opens, for a host that must get out of the way first: the browser is a screen, and
         * a Modal-backed sheet would otherwise stay above it.
         */
        onBeforeOpenLink?: () => void;
        /**
         * Set while the reply streams in: the text that arrives fades in over 500ms, as on Desktop. Unset renders plain
         * text.
         */
        reveal?: ConversationMarkdownReveal;
        text: string;
        theme: MobileTheme;
    }) => {
        const monospace = MONOSPACE_FONT;
        const markdownStyle = useMemo(
            () => ({
                body: { color: theme.text, fontSize: 15, lineHeight: 23 },
                blockquote: {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderLeftWidth: 3,
                    marginLeft: 0,
                    paddingHorizontal: 10,
                },
                heading1: headingStyle(19, theme.text),
                heading2: headingStyle(17, theme.text),
                heading3: headingStyle(16, theme.text),
                heading4: headingStyle(15, theme.text),
                heading5: headingStyle(15, theme.muted),
                heading6: headingStyle(15, theme.muted),
                hr: { backgroundColor: theme.border },
                code_inline: {
                    backgroundColor: theme.surface,
                    color: theme.text,
                    fontFamily: monospace,
                    fontSize: 13,
                },
                link: { color: theme.primary },
            }),
            [monospace, theme],
        );
        const onLinkPress = useCallback(
            (url: string) => {
                onBeforeOpenLink?.();
                openLink(url);
                // The library opens the link itself unless the handler returns false.
                return false;
            },
            [onBeforeOpenLink],
        );
        const rules = useMemo<RenderRules>(
            () => ({
                image: () => null,
                // The library wraps a link in a `Pressable`, a View that sits inside the paragraph's text as one
                // unbreakable box: after other text it rides above the baseline and a long URL runs off the screen. A
                // nested pressable `Text` flows, aligns, and wraps with the words around it.
                link: (node, children, _parents, styles) => (
                    <Text
                        accessibilityRole="link"
                        key={node.key}
                        onPress={() => onLinkPress(node.attributes.href)}
                        style={styles.link}
                    >
                        {children}
                    </Text>
                ),
                // A run that just arrived is a nested span whose color fades in: the reply's tail reads as a soft
                // gradient. A span takes no `opacity` of its own inside a `Text`, so the color carries it.
                [FADING_TEXT_NODE]: (node, _children, _parents, styles, inheritedStyles) => {
                    const fading = fadingTextOf(node);
                    const inherited = (inheritedStyles ?? {}) as TextStyle;
                    const color =
                        typeof inherited.color === 'string' ? inherited.color : theme.text;
                    return (
                        <Text key={node.key} style={[inherited, styles.text]}>
                            {node.content.slice(0, fading?.settledEnd)}
                            {fading?.runs.map((run) => (
                                <Text
                                    key={run.start}
                                    style={{ color: colorWithOpacity(color, run.opacity) }}
                                >
                                    {node.content.slice(run.start, run.end)}
                                </Text>
                            ))}
                        </Text>
                    );
                },
                code_block: (node) => (
                    <ConversationCodeBlock
                        code={node.content}
                        key={node.key}
                        language={null}
                        monospace={monospace}
                        testID="conversation-indented-code"
                        theme={theme}
                    />
                ),
                // The library's own fence paints with a different theme in non-selectable rows; this one matches the
                // tool detail's Dracula colors and stays selectable like an indented block.
                fence: (node) => (
                    <ConversationCodeBlock
                        code={node.content}
                        key={node.key}
                        language={fenceLanguage(
                            typeof node.sourceInfo === 'string' ? node.sourceInfo : undefined,
                        )}
                        monospace={monospace}
                        testID="conversation-fenced-code"
                        theme={theme}
                    />
                ),
            }),
            [monospace, onLinkPress, theme],
        );
        const source = useRevealingMarkdown(text, reveal);
        return (
            <Markdown
                allowedImageHandlers={NO_IMAGE_HANDLERS}
                onLinkPress={onLinkPress}
                colorScheme="dark"
                defaultImageHandler={null}
                markdownit={MARKDOWN_IT}
                rules={rules}
                style={markdownStyle}
                topLevelMaxExceededItem={TOP_LEVEL_MAX_EXCEEDED_ITEM}
            >
                {source}
            </Markdown>
        );
    },
);
