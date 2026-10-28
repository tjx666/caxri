/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatResponse } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { mobileControl, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The buttons and answer state a request body shares with its card: whether answering is possible, which button is in
 * flight, and how to send.
 */
export interface RequestActions {
    isDisabled: boolean;
    isShowsActions: boolean;
    pendingAction: string | null;
    respond: (action: string, response: AgentChatResponse) => Promise<void>;
}

/**
 * Text clamped to `maxLines`, with a Show more / Show less toggle when the clamp hides content, so a long command,
 * plan, or delegated task can still be read. A row in a recycled list passes `expansion` so the list owns the state and
 * a recycled row never carries another message's.
 */
export const ClampedText = ({
    expansion,
    maxLines,
    style,
    testID,
    text,
    theme,
}: {
    expansion?: { isExpanded: boolean; onToggle: () => void };
    maxLines: number;
    style: StyleProp<TextStyle>;
    testID?: string;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isLocallyExpanded, setLocallyExpanded] = useState(false);
    const isExpanded = expansion?.isExpanded ?? isLocallyExpanded;
    const [isTruncatable, setTruncatable] = useState(false);
    return (
        <View>
            <Text numberOfLines={isExpanded ? undefined : maxLines} style={style} testID={testID}>
                {text}
            </Text>
            {/*
             * An invisible unclamped copy at the same width reports whether the clamp hides anything; a clamped Text's
             * own layout does not say so consistently across platforms, as in `conversation-system-event.tsx`.
             */}
            <Text
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                onTextLayout={({ nativeEvent }) =>
                    setTruncatable(nativeEvent.lines.length > maxLines)
                }
                style={[style, styles.probe]}
            >
                {text}
            </Text>
            {isTruncatable ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    hitSlop={4}
                    onPress={() =>
                        expansion ? expansion.onToggle() : setLocallyExpanded((current) => !current)
                    }
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
    probe: { left: 0, opacity: 0, position: 'absolute', right: 0, top: 0 },
    toggle: {
        alignSelf: 'flex-start',
        justifyContent: 'center',
        minHeight: mobileControl.row,
        minWidth: mobileControl.row,
    },
    toggleLabel: { ...mobileType.meta, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
