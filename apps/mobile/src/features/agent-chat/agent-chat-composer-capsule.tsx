/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles } from '../sessions/components/session-detail-styles';

/**
 * The Chat composer's capsule in its two layouts (`agentChatComposerLayout`). Collapsed, it is one row: `+`, the input,
 * and the send controls. Expanded, the input spans the top row and a second row holds `+`, the settings chips, and the
 * send controls. The input keeps the same position among its siblings in both layouts (the slots before and after it
 * render `null` instead of disappearing), so React keeps the same native input and its focus and keyboard survive the
 * switch that focusing it causes.
 */
export const AgentChatComposerCapsule = ({
    add,
    input,
    isExpanded,
    send,
    settings,
    theme,
}: {
    add: ReactNode;
    input: ReactNode;
    isExpanded: boolean;
    send: ReactNode;
    /**
     * The settings chips; shown only while expanded.
     */
    settings: ReactNode;
    theme: MobileTheme;
}) => (
    <View
        style={[
            sessionDetailStyles.capsule,
            { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
        testID="agent-chat-composer-capsule"
    >
        <View style={isExpanded ? null : sessionDetailStyles.composerRow}>
            {isExpanded ? null : add}
            {input}
            {isExpanded ? null : send}
        </View>
        {isExpanded ? (
            <View style={sessionDetailStyles.composerRow}>
                {add}
                <View style={styles.settings}>{settings}</View>
                {send}
            </View>
        ) : null}
    </View>
);

const styles = StyleSheet.create({
    /**
     * Takes the row's spare width so the send controls stay at the trailing edge; the model chip shrinks first.
     */
    settings: {
        alignItems: 'center',
        alignSelf: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minWidth: 0,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
