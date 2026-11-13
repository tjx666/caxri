/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { MaskedView } from '../../components/masked-view';

/**
 * What both folds of `AgentChatQuestionBody` take: the Markdown, the fold, and where to report its full height.
 */
interface QuestionFoldProperties {
    children: ReactNode;
    isCut: boolean;
    isFolded: boolean;
    maxHeight: number;
    onContentHeight: (height: number) => void;
}

/**
 * A pending question scrolls inside its fold, so it reads to the end without leaving the card, which in the Sessions
 * list may also be the only way to see it. The scroll view reports the content's full height: measured from a child of
 * the clipped box, a question cut in the Sessions list read as fitting and lost Show more. Always masked, so the scroll
 * view is not remounted mid-read (losing its position); the fade marks more text below and lifts once the reader
 * scrolls to the end.
 */
export const PendingQuestionFold = ({
    children,
    contentHeight,
    isCut,
    isFolded,
    maxHeight,
    onContentHeight,
}: QuestionFoldProperties & { contentHeight: number }) => {
    /**
     * Where the reader's last scroll came to rest, read when a drag or its momentum ends rather than on every frame.
     * Whether that is the end is derived against the current fold, so a keyboard that shrinks the fold never leaves the
     * fade on or off at the wrong place.
     */
    const [scrollOffset, setScrollOffset] = useState(0);
    const isScrolledToEnd = scrollOffset + maxHeight >= contentHeight - 1;
    const trackScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) =>
        setScrollOffset(nativeEvent.contentOffset.y);
    return (
        <MaskedView maskElement={<FoldFade isFaded={isFolded && isCut && !isScrolledToEnd} />}>
            <ScrollView
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                onContentSizeChange={(_width, height) => onContentHeight(height)}
                onMomentumScrollEnd={trackScroll}
                onScrollEndDrag={trackScroll}
                persistentScrollbar
                scrollEnabled={isFolded}
                style={isFolded ? { maxHeight } : null}
            >
                {children}
            </ScrollView>
        </MaskedView>
    );
};

/**
 * An answered question in the transcript, which does not scroll there; a child keeps its own height inside a clipped
 * parent, so it measures itself. Paragraphs, list items, and code differ in height, so a fixed fold cannot always land
 * between lines; the cut edge fades out, as Desktop's does, instead of showing half a line.
 */
export const RecordQuestionFold = ({
    children,
    isCut,
    isFolded,
    maxHeight,
    onContentHeight,
}: QuestionFoldProperties) => {
    const content = (
        <View onLayout={({ nativeEvent }) => onContentHeight(nativeEvent.layout.height)}>
            {children}
        </View>
    );
    if (!isFolded) return content;
    if (!isCut) return <View style={[styles.folded, { maxHeight }]}>{content}</View>;
    return (
        <MaskedView maskElement={<FoldFade isFaded />} style={[styles.folded, { maxHeight }]}>
            {content}
        </MaskedView>
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
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
