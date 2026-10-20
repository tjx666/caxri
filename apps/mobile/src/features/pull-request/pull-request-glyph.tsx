import type { MobilePullRequest } from '@caxri/protocol';
import {
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
} from 'lucide-react-native';

/**
 * The lifecycle glyph GitHub and Desktop use: open, draft, merged, closed.
 */
export const PullRequestGlyph = ({
    color,
    pullRequest,
    size,
}: {
    color: string;
    pullRequest: MobilePullRequest;
    size: number;
}) => {
    const properties = { color, size, strokeWidth: 2.25 };
    switch (pullRequest.lifecycle) {
        case 'merged':
            return <GitMerge {...properties} />;
        case 'closed':
            return <GitPullRequestClosed {...properties} />;
        case 'draft':
            return <GitPullRequestDraft {...properties} />;
        default:
            return <GitPullRequest {...properties} />;
    }
};
