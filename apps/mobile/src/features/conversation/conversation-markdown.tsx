import { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';

import type { RenderRules } from '@ronradtke/react-native-markdown-display';
import Markdown from '@ronradtke/react-native-markdown-display';

import type { MobileTheme } from '../../theme/tokens';

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
            fence: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 },
            fence_code: { backgroundColor: theme.surface },
            fence_token: { color: theme.text, fontFamily: monospace },
            link: { color: theme.primary },
        }),
        [monospace, theme],
    );
    const rules = useMemo<RenderRules>(
        () => ({
            image: () => null,
            code_block: (node) => (
                <View
                    key={node.key}
                    style={{
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                        borderWidth: 1,
                    }}
                    testID="conversation-indented-code"
                >
                    <ScrollView horizontal showsHorizontalScrollIndicator>
                        <Text
                            selectable
                            style={{
                                color: theme.text,
                                fontFamily: monospace,
                                fontSize: 13,
                                padding: 12,
                            }}
                        >
                            {node.content.replace(/\n$/u, '')}
                        </Text>
                    </ScrollView>
                </View>
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
