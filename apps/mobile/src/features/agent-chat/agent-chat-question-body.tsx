/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useId, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { MaskedView } from '../../components/masked-view';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';
import {
    CONVERSATION_MARKDOWN,
    CONVERSATION_MARKDOWN_COMPACT,
} from '../conversation/conversation-markdown-size';

/**
 * The question an Agent asks, rendered as Markdown like its replies, as Desktop's `AgentChatQuestionBody` does, so
 * paragraphs, numbered steps, and `code` keep their shape. A long question folds to three lines with Show more so the
 * options below stay in view; while the keyboard is up it folds to two lines without the toggle. `isRecord` is the
 * answered question in the transcript, as Desktop sets it: muted, at the record's 13px size. The host keys it by
 * question, so each one starts folded.
 */
export const AgentChatQuestionBody = ({
    isKeyboardVisible = false,
    isRecord = false,
    testID,
    text,
    theme,
}: {
    isKeyboardVisible?: boolean;
    isRecord?: boolean;
    testID?: string;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const [contentHeight, setContentHeight] = useState(0);
    const size = isRecord ? CONVERSATION_MARKDOWN_COMPACT : CONVERSATION_MARKDOWN;
    const markdownTheme = useMemo(
        () => (isRecord ? { ...theme, text: theme.muted } : theme),
        [isRecord, theme],
    );
    /**
     * Whole lines plus the first paragraph's top margin, which the fold keeps as a reply shows it. A question whose
     * last paragraph ends within the fold is not cut by its bottom margin.
     */
    const margin = size.paragraph.marginTop;
    const maxHeight = margin + (isKeyboardVisible ? 2 : 3) * size.body.lineHeight;
    const isFolded = isKeyboardVisible || !isExpanded;
    // Measured on the unclamped content: a child keeps its own height inside a clipped parent.
    const isCut = contentHeight > maxHeight + margin + 1;
    const content = (
        <View onLayout={({ nativeEvent }) => setContentHeight(nativeEvent.layout.height)}>
            <ConversationMarkdown isCompact={isRecord} text={text} theme={markdownTheme} />
        </View>
    );
    return (
        <View>
            <View testID={testID}>
                {isFolded && isCut ? (
                    /**
                     * Paragraphs, list items, and code differ in height, so a fixed fold cannot always land between
                     * lines; the cut edge fades out, as Desktop's does, instead of showing half a line.
                     */
                    <MaskedView maskElement={<FoldFade />} style={[styles.folded, { maxHeight }]}>
                        {content}
                    </MaskedView>
                ) : (
                    <View style={isFolded ? [styles.folded, { maxHeight }] : null}>{content}</View>
                )}
            </View>
            {!isKeyboardVisible && (isCut || isExpanded) ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    hitSlop={4}
                    onPress={() => setExpanded((current) => !current)}
                    style={styles.toggle}
                    testID={testID ? `${testID}-toggle` : undefined}
                >
                    <Text style={[styles.toggleLabel, { color: theme.primary }]}>
                        {t(isExpanded ? 'chat.showLess' : 'chat.showMore')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * Opaque over the top 60% of the folded box and fading to clear at its bottom, Desktop's `linear-gradient(to bottom,
 * black 60%, transparent)` mask.
 */
const FoldFade = () => {
    const id = useId();
    return (
        <Svg height="100%" width="100%">
            <Defs>
                <LinearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                    <Stop offset="0.6" stopColor="black" stopOpacity={1} />
                    <Stop offset="1" stopColor="black" stopOpacity={0} />
                </LinearGradient>
            </Defs>
            <Rect fill={`url(#${id})`} height="100%" width="100%" />
        </Svg>
    );
};

const styles = StyleSheet.create({
    folded: { overflow: 'hidden' },
    toggle: {
        alignSelf: 'flex-start',
        justifyContent: 'center',
        minHeight: mobileControl.row,
        minWidth: mobileControl.row,
    },
    toggleLabel: { ...mobileType.meta, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
