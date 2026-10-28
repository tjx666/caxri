/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { MobilePullRequest } from '@caxri/protocol';
import { ExternalLink } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel, SheetTitle } from '../../components/bottom-sheet';
import { Button } from '../../components/button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { openLink } from '../../lib/open-link';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { PullRequestGlyph } from './pull-request-glyph';
import { isMergeInProgress } from './pull-request-merge-store';
import type { PullRequestMergeAction } from './pull-request-model';
import {
    isConfirmablePullRequestAction,
    pullRequestChecksSummary,
    pullRequestConfirmation,
    pullRequestMergeAction,
    pullRequestMergeMethodNote,
    pullRequestReadiness,
    pullRequestTone,
    pullRequestToneColor,
    shouldShowPullRequestConfirmation,
} from './pull-request-model';
import type { useSessionPullRequest } from './use-session-pull-request';

type PullRequestState = ReturnType<typeof useSessionPullRequest>;

/**
 * The Session's pull request on the phone: what it is, whether its checks passed, and the same merge Desktop's Status
 * panel offers. Every merge asks first, since it cannot be undone from Caxri: a ready pull request on a plain
 * confirmation, any other reason on a second page of the same sheet (so the keyboard-free confirmation never stacks a
 * dialog over the sheet), and a conflict or a draft explains the next step instead of offering a merge GitHub would
 * refuse.
 */
export const PullRequestSheet = ({
    deviceRole,
    isConnected,
    onClose,
    pullRequest,
    state,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    onClose: () => void;
    pullRequest: MobilePullRequest;
    state: PullRequestState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isConfirming, setConfirming] = useState(false);
    const action = pullRequestMergeAction(pullRequest);
    const showConfirmation = shouldShowPullRequestConfirmation(isConfirming, action);
    // A refresh that leaves nothing to confirm (merged, draft, conflicting) ends the confirmation for good, so a later
    // ready state does not reopen a page the user never asked for.
    if (isConfirming && !showConfirmation) setConfirming(false);
    const tone = pullRequestToneColor(pullRequestTone(pullRequest), theme);
    const checks = pullRequestChecksSummary(pullRequest, t);
    const isMerging = isMergeInProgress(state.merge);
    const merge = (): void => {
        setConfirming(false);
        void state.startMerge(pullRequest);
    };
    return (
        <BottomSheet
            closeLabel={t('pullRequest.close')}
            onClose={onClose}
            testID="pull-request-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <View style={styles.body}>
                    <View style={styles.heading}>
                        <PullRequestGlyph color={tone} pullRequest={pullRequest} size={18} />
                        <Text style={[styles.number, { color: theme.muted }]}>
                            #{pullRequest.number}
                        </Text>
                    </View>
                    <SheetTitle
                        testID="pull-request-title"
                        theme={theme}
                        title={pullRequest.title}
                    />
                    {showConfirmation && isConfirmablePullRequestAction(action) ? (
                        <MergeConfirmation
                            action={action}
                            onBack={() => setConfirming(false)}
                            onMerge={merge}
                            pullRequest={pullRequest}
                            theme={theme}
                        />
                    ) : (
                        <>
                            <View
                                style={[styles.status, { borderColor: theme.border }]}
                                testID="pull-request-status"
                            >
                                <View style={styles.readinessLine}>
                                    <View style={[styles.dot, { backgroundColor: tone }]} />
                                    <Text style={[styles.readiness, { color: theme.text }]}>
                                        {pullRequestReadiness(pullRequest, t)}
                                    </Text>
                                </View>
                                {checks ? (
                                    <Text
                                        style={[styles.checks, { color: theme.muted }]}
                                        testID="pull-request-checks"
                                    >
                                        {checks}
                                    </Text>
                                ) : null}
                            </View>
                            <MergeArea
                                action={action}
                                deviceRole={deviceRole}
                                isConnected={isConnected}
                                isMerging={isMerging}
                                onConfirm={() => setConfirming(true)}
                                pullRequest={pullRequest}
                                theme={theme}
                            />
                        </>
                    )}
                    {state.merge.state === 'checking' ? (
                        <Text
                            accessibilityLiveRegion="polite"
                            style={[styles.outcome, { color: theme.muted }]}
                            testID="pull-request-merge-checking"
                        >
                            {t('pullRequest.mergeLostConnection')}
                        </Text>
                    ) : null}
                    {state.merge.state === 'merged' || state.merge.state === 'failed' ? (
                        <Text
                            accessibilityLiveRegion="polite"
                            accessibilityRole={state.merge.state === 'failed' ? 'alert' : 'text'}
                            style={[
                                styles.outcome,
                                {
                                    color:
                                        state.merge.state === 'failed'
                                            ? theme.danger
                                            : theme.success,
                                },
                            ]}
                            testID="pull-request-merge-outcome"
                        >
                            {state.merge.message}
                        </Text>
                    ) : null}
                    {showConfirmation || action.kind === 'draft' ? null : (
                        <SheetAction
                            icon={ExternalLink}
                            label={t('pullRequest.openOnGitHub')}
                            onPress={() => {
                                dismiss();
                                openLink(pullRequest.url);
                            }}
                            testID="pull-request-open"
                            theme={theme}
                        />
                    )}
                    {showConfirmation ? null : (
                        <SheetCancel
                            label="Done"
                            onPress={dismiss}
                            testID="pull-request-done"
                            theme={theme}
                        />
                    )}
                </View>
            )}
        </BottomSheet>
    );
};

const MergeArea = ({
    action,
    deviceRole,
    isConnected,
    isMerging,
    onConfirm,
    pullRequest,
    theme,
}: {
    action: PullRequestMergeAction;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    isMerging: boolean;
    onConfirm: () => void;
    pullRequest: MobilePullRequest;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    switch (action.kind) {
        case 'none':
            return null;
        case 'refused':
            return <Note color={theme.danger} text={t('pullRequest.refusedConflict')} />;
        case 'waiting':
            return (
                <Note
                    color={theme.muted}
                    isBusy
                    text={t('pullRequest.waitingHead')}
                    theme={theme}
                />
            );
        case 'draft':
            return (
                <View style={styles.mergeArea}>
                    <Note color={theme.muted} text={t('pullRequest.draftNote')} />
                    <Button
                        label={t('pullRequest.openOnGitHub')}
                        onPress={() => openLink(pullRequest.url)}
                        testID="pull-request-open"
                        theme={theme}
                        variant="primary"
                    />
                </View>
            );
        default:
            break;
    }
    const canMerge = deviceRole === 'control' && isConnected;
    const isOverride = action.kind === 'confirm' && action.isOverride;
    return (
        <View style={styles.mergeArea}>
            <Button
                isBusy={isMerging}
                isDisabled={!canMerge}
                label={t(
                    isMerging
                        ? 'pullRequest.merging'
                        : isOverride
                          ? 'pullRequest.mergeAnyway'
                          : 'pullRequest.merge',
                )}
                onPress={onConfirm}
                testID="pull-request-merge"
                theme={theme}
                variant={action.kind === 'merge' ? 'success' : isOverride ? 'danger' : 'secondary'}
            />
            <Text style={[styles.caption, { color: theme.muted }]}>
                {deviceRole === 'control' && isConnected
                    ? pullRequestMergeMethodNote(pullRequest, t)
                    : t(
                          deviceRole === 'control'
                              ? 'pullRequest.offline'
                              : 'pullRequest.needsControl',
                      )}
            </Text>
        </View>
    );
};

const MergeConfirmation = ({
    action,
    onBack,
    onMerge,
    pullRequest,
    theme,
}: {
    action: Extract<PullRequestMergeAction, { kind: 'confirm' | 'merge' }>;
    onBack: () => void;
    onMerge: () => void;
    pullRequest: MobilePullRequest;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isOverride = action.kind === 'confirm' && action.isOverride;
    return (
        <View style={styles.confirmation} testID="pull-request-confirmation">
            <Text style={[styles.confirmTitle, { color: theme.text }]}>
                {t('pullRequest.confirm.title', { number: pullRequest.number })}
            </Text>
            {action.kind === 'confirm' ? (
                <Text
                    style={[styles.confirmText, { color: isOverride ? theme.danger : theme.text }]}
                >
                    {pullRequestConfirmation(pullRequest, action.blocker, t)}
                </Text>
            ) : null}
            <Text style={[styles.confirmText, { color: theme.muted }]}>
                {`${pullRequestMergeMethodNote(pullRequest, t)} ${t('pullRequest.confirm.undo')}`}
            </Text>
            <View style={styles.buttons}>
                <View style={styles.buttonSlot}>
                    <Button
                        label={t('pullRequest.back')}
                        onPress={onBack}
                        testID="pull-request-confirm-back"
                        theme={theme}
                        variant="secondary"
                    />
                </View>
                <View style={styles.buttonSlot}>
                    <Button
                        label={t(isOverride ? 'pullRequest.mergeAnyway' : 'pullRequest.merge')}
                        onPress={onMerge}
                        testID="pull-request-confirm-merge"
                        theme={theme}
                        variant={isOverride ? 'danger' : 'success'}
                    />
                </View>
            </View>
        </View>
    );
};

const Note = ({
    color,
    isBusy = false,
    text,
    theme,
}: {
    color: string;
    isBusy?: boolean;
    text: string;
    theme?: MobileTheme;
}) => (
    <View style={styles.note} testID="pull-request-note">
        {isBusy && theme ? <Spinner color={theme.muted} /> : null}
        <Text style={[styles.noteText, { color }]}>{text}</Text>
    </View>
);

const styles = StyleSheet.create({
    body: { paddingHorizontal: mobileSpace.xs },
    heading: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.md,
        paddingBottom: mobileSpace.xs,
    },
    number: { ...mobileType.bodyStrong, fontVariant: ['tabular-nums'] },
    status: {
        borderRadius: mobileRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        gap: mobileSpace.xs,
        marginHorizontal: mobileSpace.sm,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
    },
    readinessLine: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    dot: { borderRadius: mobileSpace.xs, height: mobileSpace.sm, width: mobileSpace.sm },
    readiness: { ...mobileType.bodyStrong },
    checks: { ...mobileType.meta, paddingLeft: mobileSpace.lg },
    mergeArea: {
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.sm,
        paddingTop: mobileSpace.md,
    },
    caption: { ...mobileType.caption, textAlign: 'center' },
    note: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.sm,
        paddingTop: mobileSpace.md,
    },
    noteText: { ...mobileType.meta, flex: 1 },
    outcome: { ...mobileType.meta, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.md },
    confirmation: { gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm },
    confirmTitle: { ...mobileType.bodyStrong },
    confirmText: { ...mobileType.meta },
    buttons: { flexDirection: 'row', gap: mobileSpace.md, paddingTop: mobileSpace.xs },
    buttonSlot: { flex: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
