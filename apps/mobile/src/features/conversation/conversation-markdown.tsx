import type { ReactNode } from 'react';
import { createContext, memo, use, useCallback, useEffect, useMemo, useState } from 'react';
import type { TextStyle, ViewStyle } from 'react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
    fileLinkTarget,
    fileReferenceTarget,
    proseFileReferences,
} from '@caxri/markdown/file-reference';
import type { ASTNode, RenderRules } from '@ronradtke/react-native-markdown-display';
import Markdown from '@ronradtke/react-native-markdown-display';

import { CopyButton } from '../../components/copy-button';
import { HighlightedCode } from '../../components/highlighted-code';
import { useTranslation } from '../../i18n';
import { openLink } from '../../lib/open-link';
import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import { fenceLanguage } from '../panels/file-language';
import { ConversationFileOpener } from './conversation-file-opener';
import { MARKDOWN_IT, parseMarkdown } from './conversation-markdown-parser';
import { CONVERSATION_MARKDOWN, CONVERSATION_MARKDOWN_COMPACT } from './conversation-markdown-size';
import { ConversationMessageLongPress } from './conversation-message-actions';
import {
    isQuoteWorthCopying,
    quoteIndexOf,
    quoteNodeText,
    quotePlainText,
} from './conversation-quote-text';
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

const NO_IMAGE_HANDLERS: string[] = [];

/**
 * How often a reply whose stream paused redraws to carry its last runs' fade to the end, matching the pacer's redraw
 * budget (`use-conversation-paced-text`).
 */
const FADE_REDRAW_MS = 32;

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
 * The tree a reply renders, parsed with keys that hold across parses (`parseMarkdown`), and while it streams in, with
 * the text that just arrived marked to fade in (`fading_text`). The reveal follows the order of text nodes rather than
 * the rendered tree. A paused stream keeps redrawing until its last run is opaque. Times come from the caller and the
 * redraw timer, since a render must not read the clock.
 */
function useRevealingMarkdown(
    text: string,
    reveal: ConversationMarkdownReveal | undefined,
): ASTNode[] {
    const revealing = text.length <= TEXT_REVEAL_MAX_LENGTH ? reveal : undefined;
    // Parsed here rather than by the library even without a reveal, so every node keeps its key across parses.
    const nodes = useMemo(() => parseMarkdown(text), [text]);
    const [state, setState] = useState<ConversationTextReveal>();
    const [redrawnAt, setRedrawnAt] = useState(0);
    const now = Math.max(reveal?.textShownAt ?? 0, redrawnAt);
    const current = revealing
        ? nextConversationTextReveal(
              state,
              markdownTextNodes(nodes).map((node) => node.content),
              revealing.textShownAt,
              revealing.since,
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
    return current ? withFadingTextNodes(nodes, current, now) : nodes;
}

/**
 * The library defaults `topLevelMaxExceededItem` to a fresh element inline, so every render built a new AST renderer;
 * module constants keep it stable. The renderer never reaches that item because `maxTopLevelChildren` stays unset.
 */
const TOP_LEVEL_MAX_EXCEEDED_ITEM = null;

/**
 * A text run split around the file paths it cites in prose (`updated src/app.ts:12`), as Desktop's Chat links them.
 * Text inside a link keeps that link's destination.
 */
const prosePathRuns = (content: string): Array<{ file?: string; text: string }> | undefined => {
    const references = proseFileReferences(content);
    if (references.length === 0) return undefined;
    const runs: Array<{ file?: string; text: string }> = [];
    let offset = 0;
    for (const reference of references) {
        if (reference.index > offset) runs.push({ text: content.slice(offset, reference.index) });
        runs.push({ file: reference.file, text: reference.text });
        offset = reference.index + reference.text.length;
    }
    if (offset < content.length) runs.push({ text: content.slice(offset) });
    return runs;
};

/**
 * A code block in a reply: monospace and scrolled sideways rather than wrapped. Copy stays hidden so it never covers
 * the code or takes its room: a tap on the block shows it in the corner, and a tap again or a finished copy hides it,
 * as chat apps keep per-block actions out of the way on a phone. A long press still opens the message's actions
 * (`ConversationMessageLongPress`), since the tap target would otherwise swallow it. A known language paints through
 * `HighlightedCode`, which is memoized on the code and language, so a streamed reply re-tokenizes only the block still
 * growing; anything else stays one plain color. The text is not `selectable`: a selectable block opened the system
 * selection toolbar on top of the message sheet.
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
    const { t } = useTranslation();
    const openMessage = use(ConversationMessageLongPress);
    const [isCopyShown, setIsCopyShown] = useState(false);
    const toggleCopy = useCallback(() => setIsCopyShown((isShown) => !isShown), []);
    const hideCopy = useCallback(() => setIsCopyShown(false), []);
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
            <Pressable
                accessibilityActions={[{ label: t('components.copyCode'), name: 'activate' }]}
                accessibilityState={{ expanded: isCopyShown }}
                onAccessibilityAction={toggleCopy}
                onLongPress={openMessage ?? undefined}
                onPress={toggleCopy}
            >
                <ScrollView horizontal showsHorizontalScrollIndicator>
                    <Text
                        style={{
                            color: theme.text,
                            fontFamily: monospace,
                            fontSize: 13,
                            padding: 12,
                        }}
                    >
                        {language ? <HighlightedCode code={text} language={language} /> : text}
                    </Text>
                </ScrollView>
            </Pressable>
            {/* A sibling of the tap target rather than its child, so a screen reader reaches it on its own. */}
            {isCopyShown ? (
                <CopyButton
                    label={t('components.copyCode')}
                    onCopied={hideCopy}
                    testID={`${testID}-copy`}
                    text={text}
                    theme={theme}
                />
            ) : null}
        </View>
    );
};

/**
 * The reply a quote renders inside, for its Copy to re-read on tap. A context rather than a closure in the render rules
 * keeps those rules stable while a reply streams in.
 */
const ConversationQuoteSource = createContext('');

/**
 * Keeps the end of each line of a quote clear of the Copy chip in its corner.
 */
const QUOTE_WITH_COPY_STYLE: ViewStyle = { paddingRight: 44 };

/**
 * A block quote in a reply, with Copy in its corner as on a code block, because an Agent often quotes the text it
 * suggests sending on: a draft reply or message. Desktop's Chat shows the same Copy on hover; a phone has no hover, so
 * it stays visible on a quote long enough to copy separately (`isQuoteWorthCopying`). The copy is the quote's words
 * without its `>` markers (`quotePlainText`).
 */
const ConversationQuote = ({
    children,
    copyable,
    index,
    style,
    theme,
}: {
    children: ReactNode;
    /**
     * Whether the quote is long enough to earn the Copy chip (`isQuoteWorthCopying`).
     */
    copyable: boolean;
    /**
     * The quote's position among the reply's quotes; unset leaves the quote without Copy.
     */
    index: number | undefined;
    style: ViewStyle;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const source = use(ConversationQuoteSource);
    const showCopy = index !== undefined && copyable;
    return (
        // Only a quote with the Copy chip keeps the end of its lines clear of the corner; a short one uses the full width.
        <View style={showCopy ? [style, QUOTE_WITH_COPY_STYLE] : style}>
            {children}
            {index === undefined || !copyable ? null : (
                <CopyButton
                    label={t('components.copyQuote')}
                    testID={`conversation-quote-${index}-copy`}
                    text={() => quotePlainText(source, index)}
                    theme={theme}
                />
            )}
        </View>
    );
};

/**
 * Memoized on the text and theme, so a row redrawn for another reason does not re-parse its reply.
 */
export const ConversationMarkdown = memo(
    ({
        isCompact = false,
        onBeforeOpenLink,
        reveal,
        text,
        theme,
    }: {
        /**
         * Sets the body at the transcript's secondary size (`CONVERSATION_MARKDOWN_COMPACT`) for a record such as an
         * answered question, as Desktop renders it smaller than a reply.
         */
        isCompact?: boolean;
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
        const onOpenFile = use(ConversationFileOpener);
        const markdownStyle = useMemo(
            () => ({
                body: {
                    color: theme.text,
                    ...(isCompact
                        ? CONVERSATION_MARKDOWN_COMPACT.body
                        : CONVERSATION_MARKDOWN.body),
                },
                paragraph: isCompact
                    ? CONVERSATION_MARKDOWN_COMPACT.paragraph
                    : CONVERSATION_MARKDOWN.paragraph,
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
            [isCompact, monospace, theme],
        );
        /**
         * A cited path keeps its code or prose look and adds the link color and an underline, so it reads as tappable
         * without turning a reply full of paths into a wall of links.
         */
        const fileStyle = useMemo(
            () => ({ color: theme.primary, textDecorationLine: 'underline' as const }),
            [theme],
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
                // The library keys its root afresh on every render, which remounted the whole reply and snapped a
                // scrolled code block back to its start; a fixed key keeps the tree mounted.
                body: (_node, children, _parents, styles) => (
                    <View key="body" style={styles._VIEW_SAFE_body}>
                        {children}
                    </View>
                ),
                image: () => null,
                blockquote: (node, children, _parents, styles) => (
                    <ConversationQuote
                        copyable={isQuoteWorthCopying(quoteNodeText(node))}
                        index={quoteIndexOf(node)}
                        key={node.key}
                        style={styles._VIEW_SAFE_blockquote as ViewStyle}
                        theme={theme}
                    >
                        {children}
                    </ConversationQuote>
                ),
                // The library wraps a link in a `Pressable`, a View that sits inside the paragraph's text as one
                // unbreakable box: after other text it rides above the baseline and a long URL runs off the screen. A
                // nested pressable `Text` flows, aligns, and wraps with the words around it.
                // A destination that names a local file (`[a.ts](/repo/a.ts:12)`, `file:///repo/a.ts`) opens the file
                // viewer instead of the browser, as Desktop's Chat opens it in the Editor.
                link: (node, children, _parents, styles) => {
                    const { href } = node.attributes;
                    const file = onOpenFile ? fileLinkTarget(href) : undefined;
                    return (
                        <Text
                            accessibilityRole="link"
                            key={node.key}
                            onPress={() => {
                                if (file && onOpenFile) onOpenFile(file);
                                else onLinkPress(href);
                            }}
                            style={styles.link}
                        >
                            {children}
                        </Text>
                    );
                },
                // Inline code that reads as a path (`src/a.ts:12`) is a tap away from the file it names.
                code_inline: (node, _children, _parents, styles, inheritedStyles) => {
                    const file = onOpenFile ? fileReferenceTarget(node.content) : undefined;
                    return (
                        <Text
                            accessibilityRole={file ? 'link' : undefined}
                            key={node.key}
                            onPress={file && onOpenFile ? () => onOpenFile(file) : undefined}
                            style={[
                                inheritedStyles as TextStyle,
                                styles.code_inline,
                                file && fileStyle,
                            ]}
                        >
                            {node.content}
                        </Text>
                    );
                },
                text: (node, _children, parents, styles, inheritedStyles) => {
                    const runs =
                        onOpenFile && parents.every((parent) => parent.type !== 'link')
                            ? prosePathRuns(node.content)
                            : undefined;
                    return (
                        <Text key={node.key} style={[inheritedStyles as TextStyle, styles.text]}>
                            {runs
                                ? runs.map((run, index) =>
                                      run.file ? (
                                          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- Runs split one text node in order and may repeat; the position is the run.
                                          <Text
                                              accessibilityRole="link"
                                              key={index}
                                              onPress={() => onOpenFile?.(run.file!)}
                                              style={fileStyle}
                                          >
                                              {run.text}
                                          </Text>
                                      ) : (
                                          run.text
                                      ),
                                  )
                                : node.content}
                        </Text>
                    );
                },
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
            [fileStyle, monospace, onLinkPress, onOpenFile, theme],
        );
        const source = useRevealingMarkdown(text, reveal);
        return (
            <ConversationQuoteSource value={text}>
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
            </ConversationQuoteSource>
        );
    },
);
