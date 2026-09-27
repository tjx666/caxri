import { useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    FlatList,
    Pressable,
    Text,
    TextInput,
    useWindowDimensions,
    View,
} from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { AttentionAnswerDraft } from './attention-answer';
import {
    composeAttentionAnswer,
    emptyAttentionAnswerDraft,
    isAttentionAnswerDraftEmpty,
    toggleAttentionOption,
} from './attention-answer';
import { AttentionCardChrome, AttentionPermissionActions } from './attention-card-chrome';
import {
    attentionRequestList,
    isAttentionQueryEnabled,
    isAutoAllowGranted,
    visibleAttentionRequests,
} from './attention-cards-model';
import { AttentionEmptyState } from './attention-empty-state';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

/**
 * A busy transcript needs room too: the attention block never grows past this share of the window, and its own list
 * scrolls once a Session accumulates enough pending requests to exceed it.
 */
const ATTENTION_MAX_HEIGHT_RATIO = 0.45;

const AttentionQuestionFields = ({
    advance,
    canAnswer,
    draft,
    onFreeTextChange,
    onToggleOption,
    question,
    questionCount,
    questionIndex,
    theme,
}: {
    advance: () => Promise<void>;
    canAnswer: boolean;
    draft: AttentionAnswerDraft;
    onFreeTextChange: (value: string) => void;
    onToggleOption: (label: string) => void;
    question: Attention['questions'][number];
    questionCount: number;
    questionIndex: number;
    theme: MobileTheme;
}) => {
    const selectedOptions = new Set(draft.selectedOptions);
    return (
        <View style={{ gap: 8 }}>
            <Text style={{ color: theme.text }}>{question.question}</Text>
            {question.options.map((option, optionIndex) => (
                <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: !canAnswer,
                        selected: selectedOptions.has(option.label),
                    }}
                    disabled={!canAnswer}
                    key={option.label}
                    style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 8 }}
                    testID={`attention-option-${questionIndex}-${optionIndex}`}
                    onPress={() => onToggleOption(option.label)}
                >
                    <Text style={{ color: theme.primary }}>
                        {option.label}
                        {option.description ? ` · ${option.description}` : ''}
                    </Text>
                </Pressable>
            ))}
            {canAnswer ? (
                <>
                    <TextInput
                        accessibilityLabel="Your answer"
                        onChangeText={onFreeTextChange}
                        placeholder="Or enter your own answer"
                        placeholderTextColor={theme.muted}
                        style={{
                            color: theme.text,
                            borderColor: theme.border,
                            borderWidth: 1,
                            padding: 8,
                        }}
                        value={draft.freeText}
                        testID="attention-answer-input"
                    />
                    <Pressable
                        accessibilityLabel={
                            questionIndex + 1 < questionCount ? 'Next question' : 'Submit answers'
                        }
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isAttentionAnswerDraftEmpty(draft) }}
                        disabled={isAttentionAnswerDraftEmpty(draft)}
                        style={{ justifyContent: 'center', minHeight: 44 }}
                        testID="attention-answer-next"
                        onPress={advance}
                    >
                        <Text style={{ color: theme.primary }}>
                            {questionIndex + 1 < questionCount ? 'Next' : 'Submit'}
                        </Text>
                    </Pressable>
                </>
            ) : null}
        </View>
    );
};

const AttentionCard = ({
    onOpenTerminal,
    request: item,
    role,
    submit,
    theme,
}: {
    onOpenTerminal?: () => void;
    request: Attention;
    role: 'view' | 'reply' | 'control' | null;
    submit: (
        requestId: string,
        answer: {
            decision?: 'allow' | 'deny';
            autoAllow?: true;
            answers?: Record<string, string>;
        },
    ) => Promise<void>;
    theme: MobileTheme;
}) => {
    const [questionIndex, setQuestionIndex] = useState(0);
    const answers = useRef<Record<string, AttentionAnswerDraft>>({});
    const [draft, setDraft] = useState<AttentionAnswerDraft>(emptyAttentionAnswerDraft);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isPending = item.status === 'pending';
    const canAnswer = isPending && role === 'control' && !busy;
    const question = item.questions.at(questionIndex);
    const send = async (answer: {
        decision?: 'allow' | 'deny';
        autoAllow?: true;
        answers?: Record<string, string>;
    }) => {
        setBusy(true);
        setError(null);
        try {
            await submit(item.id, answer);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : 'Unable to answer this request.');
        } finally {
            setBusy(false);
        }
    };
    const toggleOption = (label: string): void => {
        if (!question) return;
        setDraft((current) => ({
            ...current,
            selectedOptions: toggleAttentionOption(
                current.selectedOptions,
                label,
                question.multiSelect,
            ),
        }));
    };
    const setFreeText = (value: string): void => {
        setDraft((current) => ({ ...current, freeText: value }));
    };
    const advance = async () => {
        if (!question || isAttentionAnswerDraftEmpty(draft)) return;
        const next = { ...answers.current, [question.question]: draft };
        answers.current = next;
        if (questionIndex + 1 < item.questions.length) {
            const nextQuestion = item.questions[questionIndex + 1];
            setQuestionIndex(questionIndex + 1);
            setDraft(next[nextQuestion.question] ?? emptyAttentionAnswerDraft());
        } else {
            const composedAnswers: Record<string, string> = {};
            for (const [key, value] of Object.entries(next))
                composedAnswers[key] = composeAttentionAnswer(
                    value.selectedOptions,
                    value.freeText,
                );
            await send({ answers: composedAnswers });
        }
    };
    return (
        <View
            accessibilityLiveRegion={item.kind === 'permission' ? 'assertive' : 'polite'}
            style={{
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surface,
                padding: 12,
                gap: 8,
            }}
            testID={`attention-${item.id}`}
        >
            <AttentionCardChrome
                item={item}
                questionIndex={questionIndex}
                role={role}
                theme={theme}
            />
            {canAnswer && item.kind === 'permission' ? (
                <AttentionPermissionActions
                    send={(decision, shouldAutoAllow) =>
                        send(
                            shouldAutoAllow
                                ? { decision, autoAllow: shouldAutoAllow }
                                : { decision },
                        )
                    }
                    theme={theme}
                />
            ) : null}
            {question && item.kind === 'question' ? (
                <AttentionQuestionFields
                    advance={advance}
                    canAnswer={canAnswer}
                    draft={draft}
                    onFreeTextChange={setFreeText}
                    onToggleOption={toggleOption}
                    question={question}
                    questionCount={item.questions.length}
                    questionIndex={questionIndex}
                    theme={theme}
                />
            ) : null}
            {error ? (
                <View style={{ gap: 4 }}>
                    <Text accessibilityRole="alert" style={{ color: theme.danger }}>
                        {error}
                    </Text>
                    {onOpenTerminal ? (
                        <Pressable
                            accessibilityLabel="Open Terminal"
                            accessibilityRole="button"
                            onPress={onOpenTerminal}
                            style={{ justifyContent: 'center', minHeight: 44 }}
                            testID="attention-open-terminal"
                        >
                            <Text style={{ color: theme.primary, textDecorationLine: 'underline' }}>
                                Open Terminal if the request is still waiting.
                            </Text>
                        </Pressable>
                    ) : (
                        <Text style={{ color: theme.muted }}>
                            Open Terminal if the request is still waiting.
                        </Text>
                    )}
                </View>
            ) : null}
        </View>
    );
};

/**
 * Shown whenever the Session's "Always allow in this Session" grant (issue caxri#1295) is active, regardless of whether
 * any permission request is currently pending, so a `control` device can always find the revoke action and every role
 * can see the grant is on. `onRevoke` is `null` for `view`/`reply` devices, which keep the Server's read-only role rule
 * and never see the control.
 */
const AttentionAutoAllowBanner = ({
    onRevoke,
    theme,
}: {
    onRevoke: (() => Promise<void>) | null;
    theme: MobileTheme;
}) => {
    const [busy, setBusy] = useState(false);
    return (
        <View
            style={{
                alignItems: 'center',
                backgroundColor: theme.surface,
                borderColor: theme.border,
                borderWidth: 1,
                flexDirection: 'row',
                gap: 8,
                justifyContent: 'space-between',
                padding: 8,
            }}
            testID="attention-auto-allow-banner"
        >
            <Text style={{ color: theme.text, flex: 1 }}>
                Always allow is on: every later permission request in this Session is allowed
                automatically.
            </Text>
            {onRevoke ? (
                <Pressable
                    accessibilityLabel="Turn off Always allow"
                    accessibilityRole="button"
                    disabled={busy}
                    style={{ justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 }}
                    testID="attention-auto-allow-revoke"
                    onPress={async () => {
                        setBusy(true);
                        try {
                            await onRevoke();
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <Text style={{ color: theme.primary, fontWeight: '600' }}>Turn off</Text>
                </Pressable>
            ) : null}
        </View>
    );
};

export const AttentionCards = ({
    fallbackToTerminal,
    onOpenTerminal,
    sessionId,
    role,
    theme,
}: {
    fallbackToTerminal?: boolean;
    /**
     * Switches the parent Session view to its Terminal segment. Undefined where the caller has no Terminal segment to
     * switch to, so "Open Terminal" copy stays informational text instead of a dead-end control.
     */
    onOpenTerminal?: () => void;
    sessionId: string;
    role: 'view' | 'reply' | 'control' | null;
    theme: MobileTheme;
}) => {
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const { height: windowHeight } = useWindowDimensions();
    const [expanded, setExpanded] = useState(false);
    /**
     * Tracks request ids already observed so a newly _appearing_ pending request can be announced without re-announcing
     * every request that was already pending when this card first mounted.
     */
    const seenRequestIds = useRef<Set<string> | null>(null);
    const attention = useQuery({
        enabled: isAttentionQueryEnabled(isForeground, status, connectionScopeKey),
        queryFn: () => request('mobile.attention.list', { sessionId }),
        queryKey: ['mobile', 'attention', connectionScopeKey, sessionId],
        refetchInterval: 1_500,
        retry: false,
    });
    useEffect(() => {
        if (!attention.data) return;
        const previouslySeen = seenRequestIds.current;
        if (previouslySeen) {
            for (const item of attention.data.requests) {
                if (item.status === 'pending' && !previouslySeen.has(item.id)) {
                    AccessibilityInfo.announceForAccessibility(
                        item.kind === 'permission'
                            ? `New permission request: ${item.toolName}`
                            : 'New Agent question',
                    );
                }
            }
        }
        seenRequestIds.current = new Set(attention.data.requests.map((item) => item.id));
    }, [attention.data]);
    const requests = attentionRequestList(attention.data);
    const visible = visibleAttentionRequests(requests, expanded);
    const revokeAutoAllow = async () => {
        await request('mobile.attention.autoAllowRevoke', { sessionId });
        await attention.refetch();
    };
    const banner = isAutoAllowGranted(attention.data) ? (
        <AttentionAutoAllowBanner
            onRevoke={role === 'control' ? revokeAutoAllow : null}
            theme={theme}
        />
    ) : null;
    if (visible.length === 0) {
        return (
            <AttentionEmptyState
                banner={banner}
                fallbackToTerminal={fallbackToTerminal}
                isSuccess={attention.isSuccess}
                onOpenTerminal={onOpenTerminal}
                theme={theme}
            />
        );
    }
    const hiddenCount = requests.length - visible.length;
    const submit = async (
        requestId: string,
        answer: {
            decision?: 'allow' | 'deny';
            autoAllow?: true;
            answers?: Record<string, string>;
        },
    ) => {
        await request('mobile.attention.answer', { sessionId, requestId, ...answer });
        await attention.refetch();
    };
    const renderCard = ({ item }: { item: (typeof visible)[number] }) => (
        <AttentionCard
            onOpenTerminal={onOpenTerminal}
            request={item}
            role={role}
            submit={submit}
            theme={theme}
        />
    );
    return (
        <View
            style={{ maxHeight: windowHeight * ATTENTION_MAX_HEIGHT_RATIO }}
            testID="attention-cards"
        >
            {banner}
            <FlatList
                contentContainerStyle={{ gap: 8, padding: 8 }}
                data={visible}
                keyExtractor={(item) => item.id}
                ListHeaderComponent={
                    !expanded && hiddenCount > 0 ? (
                        <Pressable
                            accessibilityLabel={`Show ${hiddenCount} more requests`}
                            accessibilityRole="button"
                            onPress={() => setExpanded(true)}
                            style={{ justifyContent: 'center', minHeight: 44 }}
                            testID="attention-show-more"
                        >
                            <Text style={{ color: theme.primary, fontWeight: '600' }}>
                                +{hiddenCount} more requests
                            </Text>
                        </Pressable>
                    ) : null
                }
                renderItem={renderCard}
            />
        </View>
    );
};
