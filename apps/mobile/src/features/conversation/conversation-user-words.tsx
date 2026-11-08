import type { TextStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';

import type { UserMessageBlock, UserMessageStyle } from '@caxri/markdown/user-message-blocks';

import { openLink } from '../../lib/open-link';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from './conversation-styles';
import type { ConversationUserTextRun } from './conversation-user-text';
import { conversationUserListLine } from './conversation-user-text';

type Block = UserMessageBlock<ConversationUserTextRun>;
type Run = Block['runs'][number];

const styles = StyleSheet.create({
    /**
     * `flexShrink`, not `flex: 1`: the bubble sizes to its content, and a zero flex basis made Yoga size it for the
     * unwrapped line, so a wrapped list item spilled below the bubble, and a message that is only a list measured as
     * wide as its numbers and wrapped one character per line.
     */
    listContent: { flexShrink: 1 },
    listLine: { flexDirection: 'row' },
    quote: {
        borderLeftWidth: 3,
        marginVertical: 2,
        paddingLeft: mobileSpace.sm,
    },
});

/**
 * Desktop's bubble styles (`STYLE_CLASSES` in `agent-chat-user-message-body.tsx`) in React Native terms. Inline code
 * sits on `elevated` because the bubble itself is `surface`.
 */
const runStyle = (styles: readonly UserMessageStyle[], theme: MobileTheme): TextStyle[] => {
    const byStyle: Record<UserMessageStyle, TextStyle> = {
        code: { backgroundColor: theme.elevated, fontFamily: MONOSPACE_FONT, fontSize: 13 },
        emphasis: { fontStyle: 'italic' },
        strike: { textDecorationLine: 'line-through' },
        strong: { fontWeight: '600' },
        syntax: { color: theme.muted },
    };
    return styles.map((style) => byStyle[style]);
};

const renderRun = (run: Run, position: number, theme: MobileTheme) => {
    if (run.kind === 'bullet')
        return (
            <Text key={position} style={{ color: theme.muted }}>
                •
            </Text>
        );
    const style = runStyle(run.styles, theme);
    if (run.kind === 'text')
        return (
            <Text key={position} style={style}>
                {run.text}
            </Text>
        );
    return (
        <Text
            accessibilityRole="link"
            key={position}
            onPress={() => openLink(run.segment.url)}
            // Underlined like a reply's link: a phone has no hover to reveal it.
            style={[...style, { color: theme.primary, textDecorationLine: 'underline' }]}
        >
            {run.segment.text}
        </Text>
    );
};

/**
 * The words the user typed, laid out as Desktop's bubble lays them out: bold, italics, strikethrough, and inline code
 * with their markers hidden, list lines with a bullet and a hanging indent, quotes behind a bar, and each pasted URL a
 * link. Headings and fenced code stay as typed (see `userMessageBlocks`).
 */
export const ConversationUserWords = ({
    blocks,
    testID,
    theme,
}: {
    blocks: readonly Block[];
    /**
     * Prefix for each block's words, `<testID>-<block index>`, so a check can read a line by its place in the message.
     */
    testID?: string;
    theme: MobileTheme;
}) => {
    const textStyle = [conversationStyles.userText, { color: theme.text }];
    const runs = (items: readonly Run[]) => items.map((run, index) => renderRun(run, index, theme));
    const blockID = (position: number) => (testID ? `${testID}-${position}` : undefined);
    // A message with no list or quote stays one Text, so it wraps and selects as it always did.
    if (blocks.length === 1 && !blocks[0]?.line)
        return (
            <Text style={textStyle} testID={blockID(0)}>
                {runs(blocks[0]?.runs ?? [])}
            </Text>
        );
    return (
        <View>
            {blocks.map((block, position) => {
                if (block.line === 'quote')
                    return (
                        <View
                            key={position}
                            style={[styles.quote, { borderLeftColor: theme.selection }]}
                        >
                            <Text
                                style={[...textStyle, { color: theme.muted }]}
                                testID={blockID(position)}
                            >
                                {runs(block.runs)}
                            </Text>
                        </View>
                    );
                if (block.line === 'list') {
                    const line = conversationUserListLine(block);
                    return (
                        <View key={position} style={styles.listLine}>
                            <Text style={textStyle}>{runs(line.marker)}</Text>
                            <Text
                                style={[...textStyle, styles.listContent]}
                                testID={blockID(position)}
                            >
                                {runs(line.content)}
                            </Text>
                        </View>
                    );
                }
                return (
                    <Text key={position} style={textStyle} testID={blockID(position)}>
                        {runs(block.runs)}
                    </Text>
                );
            })}
        </View>
    );
};
