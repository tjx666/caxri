/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatItem, AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import {
    agentChatApprovalChoices,
    agentChatRequestTitle,
    sentenceStartProvider,
} from '@caxri/protocol';
import { MessageCircleQuestionMark, ShieldAlert } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { agentChatRequestBlockedReason } from './agent-chat-model';
import { agentChatApprovalFiles, agentChatApprovalRows } from './agent-chat-model';
import { AgentChatQuestionForm } from './agent-chat-question-form';
import type { RequestActions } from './agent-chat-request-parts';
import { ClampedText } from './agent-chat-request-parts';

type ApprovalRequest = Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>;

const ApprovalBody = ({
    items,
    request,
    theme,
}: {
    items: readonly AgentChatItem[];
    request: ApprovalRequest;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const files = agentChatApprovalFiles(request, items);
    return (
        <>
            {request.kind === 'tool' && request.summary ? (
                <ClampedText
                    maxLines={6}
                    style={[styles.code, { backgroundColor: theme.elevated, color: theme.text }]}
                    testID="agent-chat-request-tool"
                    text={request.summary}
                    theme={theme}
                />
            ) : null}
            {request.kind === 'command' && request.command ? (
                <ClampedText
                    maxLines={6}
                    style={[styles.code, { backgroundColor: theme.elevated, color: theme.text }]}
                    testID="agent-chat-request-command"
                    text={request.command}
                    theme={theme}
                />
            ) : null}
            {request.kind === 'command' && request.cwd ? (
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {t('chat.request.cwd', { cwd: request.cwd })}
                </Text>
            ) : null}
            {files.length > 0 ? (
                <ClampedText
                    maxLines={4}
                    style={[styles.meta, { color: theme.muted }]}
                    testID="agent-chat-request-files"
                    text={files.join('\n')}
                    theme={theme}
                />
            ) : null}
            {request.reason ? (
                <Text numberOfLines={4} style={[styles.meta, { color: theme.muted }]}>
                    {request.reason}
                </Text>
            ) : null}
        </>
    );
};

/**
 * An approval with the decisions the provider offers, worded by the shared protocol module so the phone reads like the
 * Desktop Chat.
 */
const ApprovalContent = ({
    actions,
    items,
    notice,
    request,
    theme,
}: {
    actions: RequestActions;
    items: readonly AgentChatItem[];
    notice: ReactNode;
    request: ApprovalRequest;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {/* The approval's text scrolls on its own so its decisions stay on screen in a short dock. */}
            <ScrollView
                contentContainerStyle={styles.approvalBody}
                keyboardShouldPersistTaps="handled"
                persistentScrollbar
                style={styles.scroll}
            >
                <ApprovalBody items={items} request={request} theme={theme} />
            </ScrollView>
            {notice}
            {actions.isShowsActions ? (
                <View style={styles.choices}>
                    {agentChatApprovalRows(agentChatApprovalChoices(request, t)).map((row) => (
                        <View key={row[0].decision} style={styles.actions}>
                            {row.map((choice) => {
                                const testID = `agent-chat-approval-${choice.decision.toLowerCase()}`;
                                return (
                                    <Button
                                        key={choice.decision}
                                        isDisabled={actions.isDisabled}
                                        isBusy={actions.pendingAction === testID}
                                        label={choice.label}
                                        onPress={() => {
                                            void actions.respond(testID, {
                                                kind: 'decision',
                                                decision: choice.decision,
                                            });
                                        }}
                                        testID={testID}
                                        theme={theme}
                                        variant={
                                            choice.decision === 'accept' ? 'primary' : 'outline'
                                        }
                                        style={styles.answer}
                                    />
                                );
                            })}
                        </View>
                    ))}
                </View>
            ) : null}
        </>
    );
};

/**
 * One pending Chat request: an approval or questions. Only a connected control device answers. A device without control
 * access sees the request and how to get access, with no buttons it could never press; an offline control device keeps
 * the buttons disabled until it reconnects.
 */
export const AgentChatRequestCard = ({
    blockedReason,
    items,
    onRespond,
    positionLabel,
    provider,
    request,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    items: readonly AgentChatItem[];
    onRespond: (request: AgentChatRequest, response: AgentChatResponse) => Promise<void>;
    /**
     * `1 of N` while other requests wait behind this one in the dock.
     */
    positionLabel?: string;
    provider: string;
    request: AgentChatRequest;
    theme: MobileTheme;
}) => {
    /**
     * The test id of the button whose answer is in flight, so only that button shows a spinner.
     */
    const { t } = useTranslation();
    const [pendingAction, setPendingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const actions: RequestActions = {
        isDisabled: blockedReason !== undefined || pendingAction !== null,
        isShowsActions: blockedReason?.kind !== 'access',
        pendingAction,
        respond: async (action, response) => {
            setPendingAction(action);
            setError(null);
            try {
                await onRespond(request, response);
            } catch {
                setError(t('chat.request.answerFailed'));
            } finally {
                setPendingAction(null);
            }
        },
    };
    // The only card that blocks the Agent on the user wears the attention border and a leading glyph.
    const Glyph = request.kind === 'question' ? MessageCircleQuestionMark : ShieldAlert;
    const notice = blockedReason ? (
        <Text style={[styles.meta, { color: theme.muted }]} testID="agent-chat-request-blocked">
            {blockedReason.message}
        </Text>
    ) : null;
    return (
        <Card style={styles.card} testID="agent-chat-request" theme={theme} tone="attention">
            <View style={styles.titleRow}>
                <Glyph color={theme.warning} size={18} />
                <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                    {agentChatRequestTitle(request, sentenceStartProvider(provider), t)}
                </Text>
                {positionLabel ? (
                    <Text
                        style={[styles.position, { color: theme.muted }]}
                        testID="agent-chat-request-position"
                    >
                        {positionLabel}
                    </Text>
                ) : null}
            </View>
            {request.kind === 'question' ? (
                <AgentChatQuestionForm
                    actions={actions}
                    notice={notice}
                    request={request}
                    theme={theme}
                />
            ) : (
                <ApprovalContent
                    actions={actions}
                    items={items}
                    notice={notice}
                    request={request}
                    theme={theme}
                />
            )}
            {error ? (
                <Text accessibilityRole="alert" style={[styles.meta, { color: theme.danger }]}>
                    {error}
                </Text>
            ) : null}
        </Card>
    );
};

const styles = StyleSheet.create({
    /**
     * Answer buttons share their row equally.
     */
    answer: { flex: 1 },
    /**
     * The card shrinks inside the dock's height cap; its scroll area (options or approval text) gives way first, so the
     * title and buttons stay on screen. It clips what still does not fit (`Card` clips): Yoga shrinks a card below its
     * content and draws the overflow unclipped, so the answer field and buttons used to spill over the status row and
     * composer.
     */
    card: { flexShrink: 1 },
    titleRow: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    title: { ...mobileType.bodyStrong, flexShrink: 1 },
    position: { ...mobileType.caption, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
    scroll: { flexGrow: 0, flexShrink: 1 },
    approvalBody: { gap: mobileSpace.sm },
    meta: mobileType.meta,
    code: {
        ...mobileType.meta,
        borderRadius: mobileRadius.sm,
        fontFamily: MONOSPACE_FONT,
        overflow: 'hidden',
        padding: mobileSpace.sm,
    },
    actions: { flexDirection: 'row', gap: mobileSpace.sm },
    choices: { gap: mobileSpace.sm },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
