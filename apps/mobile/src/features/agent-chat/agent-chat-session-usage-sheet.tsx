import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import type { AgentChatUsage } from '@caxri/protocol';
import { Gauge } from 'lucide-react-native';

import { BottomSheet, SheetCancel } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatSessionUsageRow } from './agent-chat-session-usage';
import { agentChatContextRing, agentChatSessionUsageView } from './agent-chat-session-usage';
import { SheetSectionLabel } from './agent-chat-sheet-primitives';
import { sheetStyles, TRIGGER_HIT_SLOP } from './agent-chat-sheet-styles';
import { useAgentChatUsage } from './use-agent-chat-plan-limits';

/**
 * The ring Desktop's composer meter draws, at the phone's trigger size: a faint full track and an arc of the share
 * used.
 */
const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The cache countdown is in minutes, so the open sheet re-reads the clock twice a minute.
 */
const CLOCK_TICK_MS = 30_000;

const styles = StyleSheet.create({
    trigger: { marginLeft: 'auto' },
    triggerPercent: { fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
    row: { gap: 2, paddingHorizontal: 10, paddingVertical: 8 },
    heading: { alignItems: 'baseline', flexDirection: 'row', gap: 12 },
    label: { flexShrink: 0 },
    value: {
        flex: 1,
        fontSize: 15,
        fontVariant: ['tabular-nums'],
        fontWeight: '600',
        textAlign: 'right',
    },
    track: { borderRadius: 3, height: 6, marginTop: 4, overflow: 'hidden' },
    fill: { borderRadius: 3, height: 6 },
});

const ContextRing = ({ color, used }: { color: string; used: number }) => (
    <Svg height={RING_SIZE} style={{ transform: [{ rotate: '-90deg' }] }} width={RING_SIZE}>
        <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            fill="none"
            opacity={0.3}
            r={RING_RADIUS}
            stroke={color}
            strokeWidth={RING_STROKE}
        />
        {used > 0 ? (
            <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                fill="none"
                r={RING_RADIUS}
                stroke={color}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - used)}
                strokeLinecap="round"
                strokeWidth={RING_STROKE}
            />
        ) : null}
    </Svg>
);

const UsageRow = ({ row, theme }: { row: AgentChatSessionUsageRow; theme: MobileTheme }) => (
    <View
        accessibilityLabel={[row.label, row.value, row.detail].filter(Boolean).join(', ')}
        accessible
        style={styles.row}
        testID={`agent-chat-usage-${row.key}`}
    >
        <View style={styles.heading}>
            <Text style={[sheetStyles.optionLabel, styles.label, { color: theme.text }]}>
                {row.label}
            </Text>
            <Text style={[styles.value, { color: theme.text }]}>{row.value}</Text>
        </View>
        {row.detail ? (
            <Text style={[sheetStyles.optionDescription, { color: theme.muted }]}>
                {row.detail}
            </Text>
        ) : null}
    </View>
);

const AgentChatSessionUsageSheet = ({
    onClose,
    terminalId,
    theme,
    usage,
}: {
    onClose: () => void;
    terminalId: string;
    theme: MobileTheme;
    usage: AgentChatUsage | undefined;
}) => {
    const { t } = useTranslation();
    const readout = useAgentChatUsage(terminalId);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
        return () => clearInterval(timer);
    }, []);
    const view = agentChatSessionUsageView(usage, readout, now, t);
    const isEmpty = !view.context && view.conversation.length === 0 && view.cache.length === 0;
    return (
        <BottomSheet
            closeLabel={t('chat.usage.close')}
            maxHeight="80%"
            onClose={onClose}
            testID="agent-chat-usage-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <ScrollView style={sheetStyles.scroll}>
                        {isEmpty ? (
                            <Text style={[sheetStyles.hint, { color: theme.muted }]}>
                                {t('chat.usage.empty')}
                            </Text>
                        ) : null}
                        {view.context ? (
                            <>
                                <SheetSectionLabel label={t('chat.usage.context')} theme={theme} />
                                <View
                                    accessibilityLabel={[view.context.value, view.context.note]
                                        .filter(Boolean)
                                        .join(', ')}
                                    accessible
                                    style={styles.row}
                                    testID="agent-chat-usage-context"
                                >
                                    <Text
                                        style={[
                                            styles.value,
                                            {
                                                color: view.context.isWarning
                                                    ? theme.warning
                                                    : theme.text,
                                            },
                                        ]}
                                    >
                                        {view.context.value}
                                    </Text>
                                    <View
                                        style={[styles.track, { backgroundColor: theme.elevated }]}
                                    >
                                        <View
                                            style={[
                                                styles.fill,
                                                {
                                                    backgroundColor: view.context.isWarning
                                                        ? theme.warning
                                                        : theme.primary,
                                                    width: `${view.context.used * 100}%`,
                                                },
                                            ]}
                                        />
                                    </View>
                                    {view.context.note ? (
                                        <Text
                                            style={[
                                                sheetStyles.optionDescription,
                                                { color: theme.muted },
                                            ]}
                                        >
                                            {view.context.note}
                                        </Text>
                                    ) : null}
                                </View>
                            </>
                        ) : null}
                        {view.conversation.length > 0 ? (
                            <SheetSectionLabel label={t('chat.usage.conversation')} theme={theme} />
                        ) : null}
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A handful of fixed rows. */}
                        {view.conversation.map((row) => (
                            <UsageRow key={row.key} row={row} theme={theme} />
                        ))}
                        {view.cache.length > 0 ? (
                            <SheetSectionLabel label={t('chat.usage.cache')} theme={theme} />
                        ) : null}
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- At most two fixed rows. */}
                        {view.cache.map((row) => (
                            <UsageRow key={row.key} row={row} theme={theme} />
                        ))}
                    </ScrollView>
                    <SheetCancel
                        label="Done"
                        onPress={dismiss}
                        testID="agent-chat-usage-done"
                        theme={theme}
                    />
                </>
            )}
        </BottomSheet>
    );
};

/**
 * The Session usage entry at the end of the composer's model row: Desktop's context ring, a quiet neutral glyph until
 * the context reaches the share where compacting is suggested, then the warning tone with the percentage. Before the
 * provider reports a window size (or for one that never does) a gauge stands in once the conversation recorded usage,
 * so tokens and cost stay one tap away. Tapping opens the Session usage sheet. Nothing renders before the first
 * response.
 */
export const AgentChatSessionUsageButton = ({
    terminalId,
    theme,
    usage,
}: {
    terminalId: string;
    theme: MobileTheme;
    usage: AgentChatUsage | undefined;
}) => {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const readout = useAgentChatUsage(terminalId, usage?.lastResponseAt);
    const ring = agentChatContextRing(usage, t);
    if (!ring && !readout) return null;
    const color = ring?.isWarning ? theme.warning : theme.muted;
    return (
        <>
            <Pressable
                accessibilityHint={t('chat.usage.openHint')}
                accessibilityLabel={ring?.accessibilityLabel ?? t('chat.usage.open')}
                accessibilityRole="button"
                hitSlop={TRIGGER_HIT_SLOP}
                onPress={() => setOpen(true)}
                style={({ pressed }) => [
                    sheetStyles.trigger,
                    styles.trigger,
                    pressed ? { backgroundColor: theme.elevated } : null,
                ]}
                testID="agent-chat-usage-button"
            >
                {ring ? (
                    <ContextRing color={color} used={ring.used} />
                ) : (
                    <Gauge color={color} size={16} />
                )}
                {ring?.isWarning ? (
                    <Text style={[styles.triggerPercent, { color }]}>{`${ring.percent}%`}</Text>
                ) : null}
            </Pressable>
            {isOpen ? (
                <AgentChatSessionUsageSheet
                    onClose={() => setOpen(false)}
                    terminalId={terminalId}
                    theme={theme}
                    usage={usage}
                />
            ) : null}
        </>
    );
};
