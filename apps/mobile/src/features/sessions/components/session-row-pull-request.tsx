import { View } from 'react-native';

import type { SessionPullRequestIcon, SessionPullRequestTone } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react-native';
import {
    GitMerge,
    GitPullRequest,
    GitPullRequestArrow,
    GitPullRequestClosed,
    Rocket,
} from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';

const ICONS: Record<SessionPullRequestIcon, LucideIcon> = {
    closed: GitPullRequestClosed,
    deployed: Rocket,
    draft: GitPullRequest,
    merged: GitMerge,
    open: GitPullRequestArrow,
};

const toneColor = (tone: SessionPullRequestTone, theme: MobileTheme): string => {
    switch (tone) {
        case 'danger':
            return theme.danger;
        case 'merged':
            return theme.merged;
        case 'success':
            return theme.success;
        case 'warning':
            return theme.warning;
        case 'neutral':
            return theme.muted;
    }
};

/**
 * The Session row's pull request mark: the same glyph and color Desktop's sidebar draws for the same pull request (the
 * shared `sessionPullRequestVisual` rule), with the state spelled out for the screen reader.
 */
export const SessionRowPullRequest = ({
    icon,
    label,
    theme,
    tone,
}: {
    icon: SessionPullRequestIcon;
    label: string;
    theme: MobileTheme;
    tone: SessionPullRequestTone;
}) => {
    const Icon = ICONS[icon];
    return (
        <View accessibilityLabel={label} accessible testID="session-row-pull-request">
            <Icon color={toneColor(tone, theme)} size={16} strokeWidth={2.25} />
        </View>
    );
};
