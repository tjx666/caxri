/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { agentApprovalAlwaysAllowLabel } from '@caxri/protocol';
import { MessageCircleQuestionMark, ShieldAlert } from 'lucide-react-native';

import { Button } from '../../components/button';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { requestControlAccessMessage } from '../agent-chat/agent-chat-model';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

const statusLabel = (status: Attention['status'], t: Translate): string => {
    if (status === 'applied') return t('conversation.attention.statusApplied');
    if (status === 'answered') return t('conversation.attention.statusSubmitting');
    return t('conversation.attention.statusClosed');
};

export const AttentionCardChrome = ({
    item,
    questionIndex,
    role,
    theme,
}: {
    item: Attention;
    questionIndex: number;
    role: 'view' | 'reply' | 'control' | null;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const Glyph = item.kind === 'permission' ? ShieldAlert : MessageCircleQuestionMark;
    return (
        <>
            <View style={styles.titleRow}>
                <Glyph color={theme.warning} size={18} />
                <Text style={[styles.title, { color: theme.text }]}>
                    {item.kind === 'permission'
                        ? t('conversation.attention.permissionTitle', { tool: item.toolName })
                        : t('conversation.attention.questionTitle', {
                              count: item.questions.length,
                              index: questionIndex + 1,
                          })}
                </Text>
            </View>
            {item.summary ? (
                <Text numberOfLines={3} style={[styles.meta, { color: theme.muted }]}>
                    {item.summary}
                </Text>
            ) : null}
            {item.status !== 'pending' ? (
                <Text style={[styles.meta, { color: theme.muted }]}>
                    {statusLabel(item.status, t)}
                </Text>
            ) : null}
            {role !== 'control' && item.status === 'pending' ? (
                <Text
                    style={[styles.meta, { color: theme.muted }]}
                    testID="attention-control-required"
                >
                    {requestControlAccessMessage(t)}
                </Text>
            ) : null}
        </>
    );
};

export const AttentionPermissionActions = ({
    send,
    theme,
}: {
    /**
     * `shouldAutoAllow` is only ever passed as `true`, matching the protocol's `autoAllow?: z.literal(true)` field.
     */
    send: (decision: 'allow' | 'deny', shouldAutoAllow?: true) => Promise<void>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    /**
     * A Terminal Agent's permission request names only the tool, so its buttons use the shared generic approval words;
     * the standing grant is scoped to the Session rather than a Chat.
     */
    const allowLabel = t('agentChat.approval.allow');
    const denyLabel = t('agentChat.approval.deny');
    const alwaysAllowLabel = agentApprovalAlwaysAllowLabel('Session', t);
    return (
        <View style={styles.choices}>
            <View style={styles.actions}>
                <Button
                    label={allowLabel}
                    onPress={() => {
                        void send('allow');
                    }}
                    style={styles.answer}
                    testID="attention-allow-once"
                    theme={theme}
                    variant="primary"
                />
                <Button
                    label={denyLabel}
                    onPress={() => {
                        void send('deny');
                    }}
                    style={styles.answer}
                    testID="attention-deny"
                    theme={theme}
                    variant="outline"
                />
            </View>
            <Button
                label={alwaysAllowLabel}
                onPress={() => {
                    void send('allow', true);
                }}
                testID="attention-always-allow"
                theme={theme}
                variant="outline"
            />
            {/* The caption sits under the button it explains, so it does not repeat the button's name or scope. */}
            <Text style={[styles.caption, { color: theme.muted }]}>
                {t('conversation.attention.alwaysAllowCaption')}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    titleRow: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    title: { ...mobileType.bodyStrong, flexShrink: 1 },
    meta: mobileType.meta,
    caption: mobileType.caption,
    choices: { gap: mobileSpace.sm },
    actions: { flexDirection: 'row', gap: mobileSpace.sm },
    answer: { flex: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
