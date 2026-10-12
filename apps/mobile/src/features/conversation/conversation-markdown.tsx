import { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';

import type { RenderRules } from '@ronradtke/react-native-markdown-display';
import Markdown from '@ronradtke/react-native-markdown-display';

import { HighlightedCode } from '../../components/highlighted-code';
import type { MobileTheme } from '../../theme/tokens';
import { fenceLanguage } from '../panels/file-language';

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

export const ConversationMarkdown = ({ text, theme }: { text: string; theme: MobileTheme }) => {
    const monospace = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
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
    const rules = useMemo<RenderRules>(
        () => ({
            image: () => null,
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
        [monospace, theme],
    );
    return (
        <Markdown
            allowedImageHandlers={[]}
            colorScheme="dark"
            defaultImageHandler={null}
            rules={rules}
            style={markdownStyle}
        >
            {text}
        </Markdown>
    );
};
