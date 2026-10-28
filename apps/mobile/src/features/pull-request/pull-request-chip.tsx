import { Chip } from '../../components/chip';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { PullRequestGlyph } from './pull-request-glyph';
import { isMergeInProgress } from './pull-request-merge-store';
import { pullRequestReadiness, pullRequestTone, pullRequestToneColor } from './pull-request-model';
import { PullRequestSheet } from './pull-request-sheet';
import type { useSessionPullRequest } from './use-session-pull-request';

export type SessionPullRequestState = ReturnType<typeof useSessionPullRequest>;

/**
 * The Session header's pull request entry: the lifecycle glyph colored by how close the pull request is to merging, and
 * its number. It stays out of the way until the Session delivers a pull request; tapping it opens the merge sheet. When
 * the Session has a pull request this is the header's only inline chip: the preview entry moves into the menu. The
 * header owns `state` and `isOpen` so it can tell whether a pull request exists.
 */
export const PullRequestChip = ({
    deviceRole,
    isConnected,
    isOpen,
    onOpenChange,
    state,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    state: SessionPullRequestState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { pullRequest } = state;
    if (!pullRequest) return null;
    const isMerging = isMergeInProgress(state.merge);
    const color = pullRequestToneColor(pullRequestTone(pullRequest), theme);
    return (
        <>
            <Chip
                accessibilityHint={t('pullRequest.chipHint')}
                accessibilityLabel={t('pullRequest.chip', {
                    number: pullRequest.number,
                    status: isMerging
                        ? t('pullRequest.merging')
                        : pullRequestReadiness(pullRequest, t),
                })}
                label={`#${pullRequest.number}`}
                onPress={() => {
                    onOpenChange(true);
                    state.refresh();
                }}
                testID="pull-request-chip"
                theme={theme}
            >
                {isMerging ? (
                    <Spinner color={color} size={16} testID="pull-request-chip-merging" />
                ) : (
                    <PullRequestGlyph color={color} pullRequest={pullRequest} size={16} />
                )}
            </Chip>
            {isOpen ? (
                <PullRequestSheet
                    deviceRole={deviceRole}
                    isConnected={isConnected}
                    onClose={() => {
                        onOpenChange(false);
                        state.dismissMergeFailure();
                    }}
                    pullRequest={pullRequest}
                    state={state}
                    theme={theme}
                />
            ) : null}
        </>
    );
};
