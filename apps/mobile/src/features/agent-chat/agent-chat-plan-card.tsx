/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatPlan } from '@caxri/protocol';
import { agentChatPlanProgress } from '@caxri/protocol';
import { Check, ChevronDown, Circle, CircleDot, ListTodo } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';

/**
 * Past this many steps the progress segments would shrink to slivers, so the row keeps only the count, as on Desktop.
 */
const MAX_PROGRESS_SEGMENTS = 10;

const StepGlyph = ({
    isTurnRunning,
    status,
    theme,
}: {
    isTurnRunning: boolean;
    status: AgentChatPlan['steps'][number]['status'];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    switch (status) {
        case 'completed': {
            return (
                <Check
                    accessibilityLabel={t('chat.plan.completed')}
                    color={theme.success}
                    size={14}
                />
            );
        }
        case 'inProgress': {
            return isTurnRunning ? (
                <Spinner
                    accessibilityLabel={t('chat.plan.inProgress')}
                    color={theme.muted}
                    size={14}
                />
            ) : (
                <CircleDot
                    accessibilityLabel={t('chat.plan.inProgress')}
                    color={theme.muted}
                    size={14}
                />
            );
        }
        case 'pending': {
            return (
                <Circle accessibilityLabel={t('chat.plan.pending')} color={theme.muted} size={14} />
            );
        }
    }
};

/**
 * The latest plan the Agent reported, docked above the composer like Desktop's: one row (the step the Agent is on, a
 * segment per step, and the count) that expands to the full list. A step left in progress after the turn ended is shown
 * still, so nothing spins while nothing runs.
 */
export const AgentChatPlanCard = ({
    isTurnRunning,
    plan,
    theme,
}: {
    isTurnRunning: boolean;
    plan: AgentChatPlan;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const { completed, current, total } = agentChatPlanProgress(plan);
    const isDone = total > 0 && completed === total;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-plan"
        >
            <Pressable
                accessibilityLabel={
                    current
                        ? t('chat.plan.progressCurrent', { completed, current, total })
                        : t('chat.plan.progress', { completed, total })
                }
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => setExpanded((expanded) => !expanded)}
                style={styles.header}
                testID="agent-chat-plan-toggle"
            >
                <ListTodo color={theme.muted} size={14} />
                <Text style={[styles.label, { color: theme.text }]}>{t('chat.plan.title')}</Text>
                <Text numberOfLines={1} style={[styles.current, { color: theme.muted }]}>
                    {!isExpanded && current ? current : ''}
                </Text>
                {total <= MAX_PROGRESS_SEGMENTS ? (
                    <View style={styles.segments}>
                        {plan.steps.map((step, index) => (
                            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- One segment per step position; steps carry no identity and may repeat their text.
                            <View
                                key={index}
                                style={[
                                    styles.segment,
                                    {
                                        backgroundColor:
                                            step.status === 'completed'
                                                ? theme.success
                                                : step.status === 'inProgress'
                                                  ? theme.muted
                                                  : theme.border,
                                    },
                                ]}
                            />
                        ))}
                    </View>
                ) : null}
                <Text style={[styles.count, { color: isDone ? theme.success : theme.muted }]}>
                    {completed}/{total}
                </Text>
                <ChevronDown
                    color={theme.muted}
                    size={14}
                    style={isExpanded ? styles.chevronOpen : null}
                />
            </Pressable>
            {isExpanded ? (
                <ScrollView nestedScrollEnabled style={styles.steps}>
                    {plan.explanation ? (
                        <Text style={[styles.explanation, { color: theme.muted }]}>
                            {plan.explanation}
                        </Text>
                    ) : null}
                    {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A plan lists a handful of steps under a short explanation in one bounded scroll. */}
                    {plan.steps.map((step, index) => (
                        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- Steps carry no identity and may repeat their text; the position is the step.
                        <View key={index} style={styles.step}>
                            <View style={styles.glyph}>
                                <StepGlyph
                                    isTurnRunning={isTurnRunning}
                                    status={step.status}
                                    theme={theme}
                                />
                            </View>
                            <Text
                                style={[
                                    styles.stepText,
                                    {
                                        color:
                                            step.status === 'completed' ? theme.muted : theme.text,
                                    },
                                ]}
                            >
                                {step.step}
                            </Text>
                        </View>
                    ))}
                </ScrollView>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 10, borderWidth: 1, marginHorizontal: 12, marginTop: 8 },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        // The header is the card's expand toggle; 48dp is the mobile minimum touch target.
        minHeight: 48,
        paddingHorizontal: 12,
    },
    label: { fontSize: 13, fontWeight: '600' },
    current: { flex: 1, fontSize: 13, minWidth: 0 },
    segments: { alignItems: 'center', flexDirection: 'row', gap: 2 },
    segment: { borderRadius: 2, height: 4, width: 10 },
    count: { fontSize: 13, fontVariant: ['tabular-nums'] },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
    steps: { flexGrow: 0, maxHeight: 240, paddingBottom: 8, paddingHorizontal: 12 },
    explanation: { fontSize: 13, lineHeight: 19, marginBottom: 4 },
    step: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, paddingVertical: 2 },
    glyph: { alignItems: 'center', height: 19, justifyContent: 'center', width: 16 },
    stepText: { flex: 1, fontSize: 13, lineHeight: 19 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
