import { ArrowUpRight, CircleDot, ClipboardCheck, GitPullRequest, ListChecks } from 'lucide-react';

import { GithubMarkIcon } from '../../icons/brands/github-mark-icon';
import { LinearLogoIcon } from '../../icons/brands/linear-logo-icon';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import type { AgentChatTrackerArtifact } from './agent-chat-trackers';

const KIND_LABEL: Record<AgentChatTrackerArtifact['kind'], string> = {
    pull: 'pull request',
    issue: 'issue',
    acceptance: 'acceptance report',
};

/**
 * The tile mark for each provider. LobeHub has no logomark here, so an acceptance report shows a checked clipboard.
 */
const PROVIDER_MARK = {
    github: GithubMarkIcon,
    linear: LinearLogoIcon,
    lobehub: ClipboardCheck,
} satisfies Record<AgentChatTrackerArtifact['provider'], unknown>;

const KIND_ICON = {
    pull: GitPullRequest,
    issue: CircleDot,
    acceptance: ListChecks,
} satisfies Record<AgentChatTrackerArtifact['kind'], unknown>;

/**
 * `Created pull request`, `Updated issue`: what the Agent did, in the words a reader scans for.
 */
function actionLabel(artifact: AgentChatTrackerArtifact): string {
    return `${artifact.action === 'created' ? 'Created' : 'Updated'} ${KIND_LABEL[artifact.kind]}`;
}

/**
 * A pull request, issue, or acceptance report the Agent created or edited this turn, as one clickable card: the
 * tracker's mark in a tile, the title beside its `owner/repo#N`, `ENG-123`, or `Round N` reference, what was done to
 * it, and the body's first line. Opens the page in the browser, which the trailing external arrow says before the
 * click; the edited-files card beside it expands in place and carries no arrow.
 */
export function AgentChatTrackerCard({ artifact }: { artifact: AgentChatTrackerArtifact }) {
    const Mark = PROVIDER_MARK[artifact.provider];
    const KindIcon = KIND_ICON[artifact.kind];
    const label = actionLabel(artifact);
    // An acceptance round ingested with `--requirement "$VAR"` carries no readable title; name the report instead of
    // promoting `Round N` to the headline.
    const title =
        artifact.title ?? (artifact.kind === 'acceptance' ? 'Acceptance report' : undefined);
    return (
        <button
            aria-label={`${label}: ${title ?? artifact.reference}, ${artifact.reference}. Open in browser`}
            className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated focus-visible:outline focus-visible:outline-accent motion-reduce:transition-none"
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
                        {title ?? artifact.reference}
                    </span>
                    {title && (
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
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </span>
        </button>
    );
}
