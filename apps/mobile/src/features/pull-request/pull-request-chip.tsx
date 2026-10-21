/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { PullRequestGlyph } from './pull-request-glyph';
import { pullRequestReadiness, pullRequestTone, pullRequestToneColor } from './pull-request-model';
import { PullRequestSheet } from './pull-request-sheet';
import { useSessionPullRequest } from './use-session-pull-request';

/**
 * The chip is 28pt tall; 8pt of slop above and below reaches the 44pt minimum touch target. The width is the glyph plus
 * the number, so the sides get the same slop.
 */
const CHIP_HIT_SLOP = { bottom: 8, left: 8, right: 8, top: 8 };

/**
 * The Session header's pull request entry: the lifecycle glyph colored by how close the pull request is to merging, and
 * its number. It stays out of the way until the Session delivers a pull request; tapping it opens the merge sheet.
 */
export const PullRequestChip = ({
    deviceRole,
    isConnected,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const state = useSessionPullRequest(sessionId, isOpen);
    const { pullRequest } = state;
    if (!pullRequest) return null;
    const color = pullRequestToneColor(pullRequestTone(pullRequest), theme);
    return (
        <>
            <Pressable
                accessibilityHint={t('pullRequest.chipHint')}
                accessibilityLabel={t('pullRequest.chip', {
                    number: pullRequest.number,
                    status: pullRequestReadiness(pullRequest, t),
                })}
                accessibilityRole="button"
                hitSlop={CHIP_HIT_SLOP}
                onPress={() => setOpen(true)}
                style={({ pressed }) => [
                    styles.chip,
                    { backgroundColor: theme.elevated, opacity: pressed ? 0.7 : 1 },
                ]}
                testID="pull-request-chip"
            >
                <PullRequestGlyph color={color} pullRequest={pullRequest} size={15} />
                <Text style={[styles.number, { color: theme.text }]}>#{pullRequest.number}</Text>
            </Pressable>
            {isOpen ? (
                <PullRequestSheet
                    deviceRole={deviceRole}
                    isConnected={isConnected}
                    onClose={() => setOpen(false)}
                    pullRequest={pullRequest}
                    state={state}
                    theme={theme}
                />
            ) : null}
        </>
    );
};

const styles = StyleSheet.create({
    chip: {
        alignItems: 'center',
        borderRadius: 14,
        flexDirection: 'row',
        gap: 5,
        height: 28,
        paddingHorizontal: 9,
    },
    number: { fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
