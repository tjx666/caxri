/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatResponse } from '@caxri/protocol';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
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
 * One answer button. `primary` is the filled default answer; every other answer, Decline included, is the outlined
 * ghost style the Desktop request card uses. The pressed button carries its own spinner while its answer is in flight.
 */
export const ActionButton = ({
    disabled,
    isPending,
    label,
    onPress,
    testID,
    theme,
    tone,
}: {
    disabled: boolean;
    isPending: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    tone: 'primary' | 'plain';
}) => {
    const color = tone === 'primary' ? theme.primaryForeground : theme.text;
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ busy: isPending, disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.action,
                {
                    backgroundColor:
                        tone === 'primary'
                            ? theme.primary
                            : pressed
                              ? theme.elevated
                              : 'transparent',
                    borderColor: tone === 'primary' ? theme.primary : theme.border,
                    opacity: disabled && !isPending ? 0.5 : pressed ? 0.76 : 1,
                },
            ]}
            testID={testID}
        >
            {isPending ? (
                <Spinner color={color} />
            ) : (
                <Text style={[styles.actionLabel, { color }]}>{label}</Text>
            )}
        </Pressable>
    );
};

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
    toggle: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 48, minWidth: 48 },
    toggleLabel: { fontSize: 13, fontWeight: '700' },
    action: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flex: 1,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 12,
    },
    actionLabel: { fontSize: 15, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
