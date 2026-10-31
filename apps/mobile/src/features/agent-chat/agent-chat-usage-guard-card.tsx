/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatHandoff, AgentChatUsageGuard } from '@caxri/protocol';
import { agentChatUsageGuardOffer, agentProviderCatalog } from '@caxri/protocol';
import * as Clipboard from 'expo-clipboard';
import { Clock, Copy, FileText, Gauge } from 'lucide-react-native';

import { Card } from '../../components/card';
import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { resetText } from './agent-chat-plan-limits';
import { agentChatUsageGuardButtons } from './agent-chat-usage-actions';
import { AgentChatUsageButtons } from './agent-chat-usage-buttons';
import { agentChatAutoContinueLabel } from './agent-chat-usage-limit';
import { useAgentChatUsageAction } from './use-agent-chat-usage-action';
import { useMinuteClock } from './use-minute-clock';

/**
 * The hand-off document this Chat's model wrote, or where it stands, as on Desktop: a spinner while it writes, the
 * reason it failed, or the text itself, scrollable inside its box and copyable, since selecting a long document by hand
 * stops at the screen edge.
 */
const HandoffDocument = ({
    document,
    theme,
}: {
    document: AgentChatHandoff;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (document.status === 'generating')
        return (
            <View style={styles.inline} testID="agent-chat-usage-guard-generating">
                <Spinner color={theme.muted} size={14} />
                <Text style={[styles.meta, { color: theme.muted }]}>
                    {t('chat.usageGuard.generating')}
                </Text>
            </View>
        );
    if (document.status === 'failed')
        return (
            <Text
                style={[styles.meta, { color: theme.muted }]}
                testID={`agent-chat-usage-guard-failed-${document.reason}`}
            >
                {t(`chat.usageGuard.failed.${document.reason}`)}
            </Text>
        );
    return (
        <View
            style={[
                styles.document,
                { backgroundColor: theme.elevated, borderColor: theme.border },
            ]}
            testID="agent-chat-usage-guard-document"
        >
            <View style={[styles.documentHeader, { borderColor: theme.border }]}>
                <FileText color={theme.muted} size={14} />
                <Text style={[styles.meta, styles.grow, { color: theme.muted }]}>
                    {t('chat.usageGuard.document')}
                </Text>
                <IconButton
                    accessibilityLabel={t('chat.usageGuard.copy')}
                    color={theme.muted}
                    icon={Copy}
                    onPress={async () => {
                        try {
                            await Clipboard.setStringAsync(document.text);
                            showToast('success', t('chat.usageGuard.copied'));
                        } catch {
                            showToast('error', t('chat.usageGuard.copyFailed'));
                        }
                    }}
                    size={16}
                    testID="agent-chat-usage-guard-copy"
                    theme={theme}
                />
            </View>
            <ScrollView nestedScrollEnabled style={styles.documentBody}>
                <Text selectable style={[styles.meta, { color: theme.text }]}>
                    {document.text}
                </Text>
            </ScrollView>
        </View>
    );
};

/**
 * The top of the Chat while its provider account is at the weekly usage guard (issue #2580), after Desktop's card: how
 * much of the week is used and when it resets, why new requests are paused, whether the stopped turn continues on its
 * own, the hand-off document, and the ways forward: Generate hand-off, Cancel the automatic continuation, and Continue
 * anyway. Continuing in another Agent lives in the Session's menu. Without reply access or a connection the buttons are
 * disabled with the reason beneath them.
 */
export const AgentChatUsageGuardCard = ({
    blockedReason,
    guard,
    provider,
    terminalId,
    theme,
}: {
    blockedReason: string | undefined;
    guard: AgentChatUsageGuard;
    /**
     * The Agent's name, for the headline.
     */
    provider: string;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { locale, t } = useTranslation();
    const now = useMinuteClock();
    const { pending, run } = useAgentChatUsageAction(terminalId);
    const offer = agentChatUsageGuardOffer(
        guard,
        agentProviderCatalog[guard.provider].capabilities.chatSideQuestion,
    );
    return (
        <Card style={styles.card} testID="agent-chat-usage-guard" theme={theme}>
            <View style={styles.inline}>
                <Gauge color={theme.warning} size={18} />
                <Text
                    accessibilityRole="alert"
                    style={[styles.title, styles.grow, { color: theme.warning }]}
                >
                    {t('chat.usageGuard.headline', {
                        provider,
                        percent: Math.floor(guard.usedPercent),
                    })}
                    <Text style={{ color: theme.muted }}>
                        {' · '}
                        {resetText(guard.resetsAt, now, t)}
                    </Text>
                </Text>
            </View>
            <Text style={[styles.meta, { color: theme.muted }]}>
                {t('chat.usageGuard.detail')}
                {offer.used ? ` ${t('chat.usageGuard.used')}` : ''}
            </Text>
            {guard.autoContinue ? (
                <View style={styles.inline}>
                    <Clock color={theme.muted} size={14} />
                    <Text style={[styles.meta, styles.grow, { color: theme.muted }]}>
                        {agentChatAutoContinueLabel(guard.autoContinue, now, locale, t)}
                    </Text>
                </View>
            ) : null}
            {guard.document ? <HandoffDocument document={guard.document} theme={theme} /> : null}
            <AgentChatUsageButtons
                blockedReason={blockedReason}
                buttons={agentChatUsageGuardButtons(guard, offer)}
                onPress={(action) => {
                    void run(action, guard.autoContinueTurnId);
                }}
                pending={pending}
                provider={provider}
                testID="agent-chat-usage-guard"
                theme={theme}
            />
        </Card>
    );
};

const styles = StyleSheet.create({
    card: { gap: mobileSpace.sm, marginHorizontal: mobileSpace.lg, marginTop: mobileSpace.sm },
    inline: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    grow: { flex: 1 },
    title: { ...mobileType.meta, fontWeight: '600' },
    meta: mobileType.meta,
    document: { borderRadius: mobileRadius.sm, borderWidth: 1, overflow: 'hidden' },
    documentHeader: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingLeft: mobileSpace.sm,
    },
    documentBody: {
        maxHeight: 160,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.xs,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
