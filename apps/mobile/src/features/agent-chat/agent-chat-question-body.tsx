/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useId, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
 * options below stay in view, and a pending one also scrolls inside the fold; while the keyboard is up it folds to two
 * lines without the toggle. `isRecord` is the answered question in the transcript, as Desktop sets it: muted, at the
 * record's 13px size. The host keys it by question, so each one starts folded.
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
    const isCut = contentHeight > maxHeight + margin + 1;
    const [isScrolledToEnd, setScrolledToEnd] = useState(false);
    const markdown = (
        <ConversationMarkdown isCompact={isRecord} text={text} theme={markdownTheme} />
    );
    /**
     * A pending question scrolls inside its fold, so it reads to the end without leaving the card, which in the
     * Sessions list may also be the only way to see it. The scroll view reports the content's full height: measured
     * from a child of the clipped box, a question cut in the Sessions list read as fitting and lost Show more.
     */
    const pending = (
        <ScrollView
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            onContentSizeChange={(_width, height) => setContentHeight(height)}
            onScroll={({ nativeEvent }) =>
                setScrolledToEnd(
                    nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >=
                        nativeEvent.contentSize.height - 1,
                )
            }
            persistentScrollbar
            scrollEnabled={isFolded}
            scrollEventThrottle={64}
            style={isFolded ? { maxHeight } : null}
        >
            {markdown}
        </ScrollView>
    );
    // A record does not scroll inside the transcript; a child keeps its own height inside a clipped parent there.
    const content = isRecord ? (
        <View onLayout={({ nativeEvent }) => setContentHeight(nativeEvent.layout.height)}>
            {markdown}
        </View>
    ) : null;
    return (
        <View>
            <View testID={testID}>
                {!isRecord ? (
                    /**
                     * Always masked, so the scroll view is never remounted (losing its position); the fade marks more
                     * text below and lifts once the reader scrolls to the end.
                     */
                    <MaskedView
                        maskElement={<FoldFade isFaded={isFolded && isCut && !isScrolledToEnd} />}
                    >
                        {pending}
                    </MaskedView>
                ) : isFolded && isCut ? (
                    /**
                     * Paragraphs, list items, and code differ in height, so a fixed fold cannot always land between
                     * lines; the cut edge fades out, as Desktop's does, instead of showing half a line.
                     */
                    <MaskedView
                        maskElement={<FoldFade isFaded />}
                        style={[styles.folded, { maxHeight }]}
                    >
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
 * black 60%, transparent)` mask. `isFaded: false` keeps the mask opaque throughout, showing every line.
 */
const FoldFade = ({ isFaded }: { isFaded: boolean }) => {
    const id = useId();
    return (
        <Svg height="100%" width="100%">
            <Defs>
                <LinearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                    <Stop offset="0.6" stopColor="black" stopOpacity={1} />
                    <Stop offset="1" stopColor="black" stopOpacity={isFaded ? 0 : 1} />
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
