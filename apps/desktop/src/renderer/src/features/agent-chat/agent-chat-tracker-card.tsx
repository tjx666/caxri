import { CircleDot, GitPullRequest } from 'lucide-react';

import { GithubMarkIcon } from '../../icons/brands/github-mark-icon';
import { LinearLogoIcon } from '../../icons/brands/linear-logo-icon';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import type { AgentChatTrackerArtifact } from './agent-chat-trackers';

const KIND_LABEL: Record<AgentChatTrackerArtifact['kind'], string> = {
    pull: 'pull request',
    issue: 'issue',
};

/**
 * `Created pull request`, `Updated issue`: what the Agent did, in the words a reader scans for.
 */
function actionLabel(artifact: AgentChatTrackerArtifact): string {
    return `${artifact.action === 'created' ? 'Created' : 'Updated'} ${KIND_LABEL[artifact.kind]}`;
}

/**
 * A pull request or issue the Agent created or edited this turn, as one clickable card: the tracker's mark in a tile,
 * the title beside its `owner/repo#N` or `ENG-123` reference, what was done to it, and the body's first line. Opens the
 * page in the browser.
 */
export function AgentChatTrackerCard({ artifact }: { artifact: AgentChatTrackerArtifact }) {
    const Mark = artifact.provider === 'github' ? GithubMarkIcon : LinearLogoIcon;
    const KindIcon = artifact.kind === 'pull' ? GitPullRequest : CircleDot;
    const label = actionLabel(artifact);
    return (
        <button
            aria-label={`${label}: ${artifact.title ?? artifact.reference}, ${artifact.reference}. Open in browser`}
            className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors duration-150 hover:bg-elevated focus-visible:outline focus-visible:outline-accent"
            data-agent-chat-tracker={artifact.provider}
            type="button"
            onClick={() => {
                // eslint-disable-next-line no-void -- openExternalUrl reports its own failures through the callback
                void openExternalUrl(artifact.url, (message) => pushToast('error', message));
            }}
        >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                <Mark className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 shrink truncate text-[13px] leading-5 text-foreground">
                        {artifact.title ?? artifact.reference}
                    </span>
                    {artifact.title && (
                        <span className="shrink-0 font-mono text-[11px] text-muted">
                            {artifact.reference}
                        </span>
                    )}
                </span>
                {artifact.excerpt && (
                    <span className="truncate text-[12px] leading-5 text-muted">
                        {artifact.excerpt}
                    </span>
                )}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                <KindIcon aria-hidden="true" className="size-3.5" />
                {label}
            </span>
        </button>
    );
}
