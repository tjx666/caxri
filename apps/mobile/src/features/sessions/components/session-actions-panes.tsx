/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { AgentProvider, MobileContinuationOrigin } from '@caxri/protocol';
import { Forward, Sparkles } from 'lucide-react-native';

import { SheetAction } from '../../../components/bottom-sheet';
import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { mobileAgentDisplayName } from '../agent-display-name';
import { useContinuationTargets } from '../hooks/use-continuation-targets';
import type { useSessionManagement } from '../hooks/use-session-management';
import { continuationChoices, sessionRenameDraft } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';

type Management = ReturnType<typeof useSessionManagement>;

/**
 * The rename field. Rename with AI asks the Session's Agent for a name and puts it in the field, so the user still
 * reads and saves it, as Desktop's inline editor does; it shows only for a Session with an Agent to ask.
 */
export const SessionRenamePane = ({
    management,
    onCancel,
    onRenamed,
    session,
    theme,
}: {
    management: Management;
    onCancel: () => void;
    onRenamed: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(session.title);
    const isBusy = management.pending?.sessionId === session.id;
    const isSuggesting = isBusy && management.pending?.action === 'suggestTitle';
    const nextTitle = sessionRenameDraft(draft, session.title);
    const submit = async (): Promise<void> => {
        if (nextTitle !== null && (await management.rename(session.id, nextTitle))) onRenamed();
    };
    const suggest = async (): Promise<void> => {
        const title = await management.suggestTitle(session.id);
        if (title !== null) setDraft(title);
    };
    return (
        <View style={styles.form}>
            <TextInput
                accessibilityLabel={t('sessions.actions.nameLabel')}
                autoFocus
                maxLength={200}
                onChangeText={setDraft}
                onSubmitEditing={() => {
                    void submit();
                }}
                placeholder={t('sessions.actions.nameLabel')}
                placeholderTextColor={theme.muted}
                returnKeyType="done"
                selectTextOnFocus
                style={[
                    styles.input,
                    {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        color: theme.text,
                    },
                ]}
                testID="session-rename-input"
                value={draft}
            />
            {session.primaryTerminal?.provider ? (
                <SheetAction
                    busy={isSuggesting}
                    disabled={isBusy}
                    icon={Sparkles}
                    label={t('sessions.actions.renameWithAi')}
                    onPress={() => {
                        void suggest();
                    }}
                    testID="session-rename-ai"
                    theme={theme}
                />
            ) : null}
            <View style={styles.buttons}>
                <Button
                    label={t('common.cancel')}
                    onPress={onCancel}
                    style={styles.button}
                    testID="session-rename-cancel"
                    theme={theme}
                    variant="outline"
                />
                <Button
                    isBusy={isBusy && !isSuggesting}
                    isDisabled={nextTitle === null || isSuggesting}
                    label={t('sessions.actions.save')}
                    onPress={() => {
                        void submit();
                    }}
                    style={styles.button}
                    testID="session-rename-save"
                    theme={theme}
                    variant="primary"
                />
            </View>
        </View>
    );
};

/**
 * Continue in Another Agent: every other provider, the unavailable ones disabled with their reason, read when the list
 * opens. Choosing one starts the new Session and opens it. The Session menu continues the Chat's latest work; a Chat's
 * usage-limit card and usage guard card pass their `origin`, so the new Session picks up from that failure.
 */
export const SessionContinuePane = ({
    isConnected = true,
    management,
    onCancel,
    onContinued,
    origin,
    sessionId,
    terminalId,
    theme,
}: {
    isConnected?: boolean;
    management: Management;
    onCancel: () => void;
    onContinued: (sessionId: string) => void;
    origin?: MobileContinuationOrigin;
    sessionId: string;
    terminalId: string | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const targets = useContinuationTargets(terminalId);
    /**
     * Read once when the list opens, as Desktop's menu does, so a reset time does not need a ticking clock.
     */
    const [now] = useState(Date.now);
    const choices = targets.data ? continuationChoices(targets.data.targets, now, t) : null;
    const isBusy = management.pending?.sessionId === sessionId;
    const pick = async (provider: AgentProvider): Promise<void> => {
        if (!terminalId) return;
        const created = await management.continueInAgent(sessionId, terminalId, provider, origin);
        if (created) onContinued(created);
    };
    const status = !isConnected
        ? t('sessions.detail.reconnectForActions')
        : targets.isError
          ? t('sessions.actions.continueLoadFailed')
          : choices === null
            ? t('sessions.actions.continueLoading')
            : choices.length === 0
              ? t('sessions.actions.continueEmpty')
              : null;
    return (
        <View style={styles.list}>
            {status ? (
                <Text
                    style={[styles.status, { color: theme.muted }]}
                    testID="session-continue-status"
                >
                    {status}
                </Text>
            ) : null}
            {choices?.map((choice) => (
                <SheetAction
                    busy={isBusy}
                    detail={choice.reason}
                    disabled={!isConnected || choice.reason !== undefined}
                    icon={Forward}
                    key={choice.provider}
                    label={mobileAgentDisplayName(choice.provider)}
                    onPress={() => {
                        void pick(choice.provider);
                    }}
                    testID={`session-continue-${choice.provider}`}
                    theme={theme}
                />
            ))}
            <View style={styles.buttons}>
                <Button
                    label={t('common.cancel')}
                    onPress={onCancel}
                    style={styles.button}
                    testID="session-continue-cancel"
                    theme={theme}
                    variant="outline"
                />
            </View>
        </View>
    );
};

/**
 * The phone's own confirmation for Delete Session, in Desktop's dialog words, since `mobile.session.delete` skips the
 * native dialog that would open on the computer.
 */
export const SessionDeletePane = ({
    management,
    onCancel,
    onDeleted,
    session,
    theme,
}: {
    management: Management;
    onCancel: () => void;
    onDeleted: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isBusy = management.pending?.sessionId === session.id;
    return (
        <View style={styles.form}>
            <Text style={[styles.detail, { color: theme.muted }]} testID="session-delete-detail">
                {t('sessions.actions.deleteDetail')}
            </Text>
            <View style={styles.buttons}>
                <Button
                    isDisabled={isBusy}
                    label={t('common.cancel')}
                    onPress={onCancel}
                    style={styles.button}
                    testID="session-delete-cancel"
                    theme={theme}
                    variant="outline"
                />
                <Button
                    isBusy={isBusy}
                    label={t('sessions.actions.deleteConfirm')}
                    onPress={() => {
                        void management.remove(session.id).then((done) => {
                            if (done) onDeleted();
                        });
                    }}
                    style={styles.button}
                    testID="session-delete-confirm"
                    theme={theme}
                    variant="danger"
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    form: { gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.sm },
    list: { gap: mobileSpace.xs, paddingTop: mobileSpace.xs },
    input: {
        ...mobileType.body,
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    buttons: { flexDirection: 'row', gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm },
    button: { flex: 1 },
    detail: { ...mobileType.body },
    status: {
        ...mobileType.body,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.sm,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
