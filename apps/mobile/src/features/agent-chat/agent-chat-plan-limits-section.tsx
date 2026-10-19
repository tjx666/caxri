import { StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatPlanLimitRows } from './agent-chat-plan-limits';
import { SheetSectionLabel } from './agent-chat-sheet-primitives';
import { sheetStyles } from './agent-chat-sheet-styles';
import { useAgentChatPlanLimits } from './use-agent-chat-plan-limits';

const styles = StyleSheet.create({
    row: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
    heading: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
    left: { fontSize: 15, fontVariant: ['tabular-nums'], fontWeight: '600' },
    track: { borderRadius: 3, height: 6, overflow: 'hidden' },
    fill: { borderRadius: 3, height: 6 },
});

/**
 * The model sheet's Plan limits: each live window of the provider's plan (`5-hour limit`, `Weekly limit`) with what is
 * left, a bar, and when it resets, the figures Desktop's status bar shows as `5h 62% · 7d 28% left`. Nothing renders
 * until the provider has reported a limit (an API key has none, and Claude Code reports one only while its Chat runs).
 */
export const AgentChatPlanLimitsSection = ({
    terminalId,
    theme,
}: {
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const limit = useAgentChatPlanLimits(terminalId);
    // The reset countdown is read when the sheet re-reads the limits, which is often enough for minutes.
    // eslint-disable-next-line react-hooks/purity -- a countdown is relative to the render time by definition
    const rows = agentChatPlanLimitRows(limit, Date.now(), t);
    if (rows.length === 0) return null;
    return (
        <View testID="agent-chat-plan-limits">
            <SheetSectionLabel label={t('chat.model.planLimits')} theme={theme} />
            {rows.map((row) => {
                const tone = row.isWarning ? theme.warning : theme.text;
                return (
                    <View
                        accessibilityLabel={[row.label, row.left, row.reset]
                            .filter(Boolean)
                            .join(', ')}
                        accessible
                        key={row.key}
                        style={styles.row}
                        testID={`agent-chat-plan-limit-${row.key}`}
                    >
                        <View style={styles.heading}>
                            <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>
                                {row.label}
                            </Text>
                            <Text style={[styles.left, { color: tone }]}>{row.left}</Text>
                        </View>
                        <View style={[styles.track, { backgroundColor: theme.elevated }]}>
                            <View
                                style={[
                                    styles.fill,
                                    {
                                        backgroundColor: row.isWarning
                                            ? theme.warning
                                            : theme.primary,
                                        width: `${row.leftPercent}%`,
                                    },
                                ]}
                            />
                        </View>
                        {row.reset ? (
                            <Text style={[sheetStyles.optionDescription, { color: theme.muted }]}>
                                {row.reset}
                            </Text>
                        ) : null}
                    </View>
                );
            })}
            <Text style={[sheetStyles.hint, { color: theme.muted }]}>
                {t('chat.model.limitsNote')}
            </Text>
        </View>
    );
};
