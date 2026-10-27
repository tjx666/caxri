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

import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import type { agentChatRequestBlockedReason } from './agent-chat-model';
import { agentChatApprovalFiles, agentChatApprovalRows } from './agent-chat-model';
import { AgentChatQuestionForm } from './agent-chat-question-form';
import type { RequestActions } from './agent-chat-request-parts';
import { ActionButton, ClampedText } from './agent-chat-request-parts';

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
                                    <ActionButton
                                        key={choice.decision}
                                        disabled={actions.isDisabled}
                                        isPending={actions.pendingAction === testID}
                                        label={choice.label}
                                        onPress={() => {
                                            void actions.respond(testID, {
                                                kind: 'decision',
                                                decision: choice.decision,
                                            });
                                        }}
                                        testID={testID}
                                        theme={theme}
                                        tone={choice.decision === 'accept' ? 'primary' : 'plain'}
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
    const notice = blockedReason ? (
        <Text style={[styles.meta, { color: theme.muted }]} testID="agent-chat-request-blocked">
            {blockedReason.message}
        </Text>
    ) : null;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-request"
        >
            <View style={styles.titleRow}>
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
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * The card shrinks inside the dock's height cap; its scroll area (options or approval text) gives way first, so the
     * title and buttons stay on screen. It clips what still does not fit: Yoga shrinks a card below its content and
     * draws the overflow unclipped, so the answer field and buttons used to spill over the status row and composer.
     */
    card: {
        borderRadius: 14,
        borderWidth: 1,
        flexShrink: 1,
        gap: 8,
        overflow: 'hidden',
        padding: 12,
    },
    titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    title: { flexShrink: 1, fontSize: 15, fontWeight: '700' },
    position: { fontSize: 12, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
    scroll: { flexGrow: 0, flexShrink: 1 },
    approvalBody: { gap: 8 },
    meta: { fontSize: 13, lineHeight: 18 },
    code: {
        borderRadius: 8,
        fontFamily: MONOSPACE_FONT,
        fontSize: 13,
        lineHeight: 18,
        overflow: 'hidden',
        padding: 8,
    },
    actions: { flexDirection: 'row', gap: 8 },
    choices: { gap: 8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
