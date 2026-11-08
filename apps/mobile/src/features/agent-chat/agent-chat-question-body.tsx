/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import { mobileControl, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';

/**
 * `ConversationMarkdown`'s body line height, so the fold lands on whole lines.
 */
const LINE_HEIGHT = 23;
/**
 * The Markdown library's margin above and below each paragraph (`paragraph` in its default styles). The fold keeps the
 * top one, as a reply shows it, and a question whose last paragraph ends within the fold is not cut by its bottom one.
 */
const PARAGRAPH_MARGIN = 10;

/**
 * The question an Agent asks, rendered as Markdown like its replies, as Desktop's `AgentChatQuestionBody` does, so
 * paragraphs, numbered steps, and `code` keep their shape. A long question folds to three lines with Show more so the
 * options below stay in view; while the keyboard is up it folds to two lines without the toggle. The form keys it by
 * question, so each one starts folded.
 */
export const AgentChatQuestionBody = ({
    isKeyboardVisible,
    testID,
    text,
    theme,
}: {
    isKeyboardVisible: boolean;
    testID?: string;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const [contentHeight, setContentHeight] = useState(0);
    const maxHeight = PARAGRAPH_MARGIN + (isKeyboardVisible ? 2 : 3) * LINE_HEIGHT;
    const isFolded = isKeyboardVisible || !isExpanded;
    // Measured on the unclamped content: a child keeps its own height inside a clipped parent.
    const isCut = contentHeight > maxHeight + PARAGRAPH_MARGIN + 1;
    return (
        <View>
            <View style={isFolded ? [styles.folded, { maxHeight }] : null} testID={testID}>
                <View onLayout={({ nativeEvent }) => setContentHeight(nativeEvent.layout.height)}>
                    <ConversationMarkdown text={text} theme={theme} />
                </View>
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
