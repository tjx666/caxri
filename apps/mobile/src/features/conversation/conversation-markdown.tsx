import { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';

import type { RenderRules } from '@ronradtke/react-native-markdown-display';
import Markdown from '@ronradtke/react-native-markdown-display';

import type { MobileTheme } from '../../theme/tokens';

export const ConversationMarkdown = ({ text, theme }: { text: string; theme: MobileTheme }) => {
    const monospace = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
    const markdownStyle = useMemo(
        () => ({
            body: { color: theme.text, fontSize: 15, lineHeight: 23 },
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
