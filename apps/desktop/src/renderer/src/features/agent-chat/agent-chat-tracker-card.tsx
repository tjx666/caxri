import type { AgentChatTrackerArtifact } from '@caxri/protocol';
import { ArrowUpRight, CircleDot, ClipboardCheck, GitPullRequest, ListChecks } from 'lucide-react';

import type { Translate, TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { GithubMarkIcon } from '../../icons/brands/github-mark-icon';
import { LinearLogoIcon } from '../../icons/brands/linear-logo-icon';
import { openExternalUrl } from '../../lib/external-link';
import { useCaxriQuery } from '../../queries/client';
import { pushToast } from '../../stores/toasts';
import {
    trackerExcerptText,
    trackerPreviewTitle,
    trackerReferenceText,
    trackerTitlePreviewRequest,
} from './agent-chat-tracker-labels';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

const ACTION_LABEL_KEYS: Record<
    AgentChatTrackerArtifact['action'],
    Record<AgentChatTrackerArtifact['kind'], TranslationKey>
> = {
    created: {
        pull: 'agentChat.tracker.createdPull',
        issue: 'agentChat.tracker.createdIssue',
        acceptance: 'agentChat.tracker.createdAcceptance',
    },
    updated: {
        pull: 'agentChat.tracker.updatedPull',
        issue: 'agentChat.tracker.updatedIssue',
        acceptance: 'agentChat.tracker.updatedAcceptance',
    },
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
function actionLabel(artifact: AgentChatTrackerArtifact, t: Translate): string {
    return t(ACTION_LABEL_KEYS[artifact.action][artifact.kind]);
}

/**
 * The title of a GitHub pull request or issue the card names only by number, read through the same Terminal reference
 * preview (and its cache) as a Chat pull request link's state glyph. The Server answers only for repositories the
 * Session already has, so another repository, a failed read, or a Chat without a Terminal leaves it `undefined`.
 */
function useTrackerPreviewTitle(artifact: AgentChatTrackerArtifact): string | undefined {
    const terminalId = useAgentChatTerminal();
    const reference = trackerTitlePreviewRequest(artifact);
    const preview = useCaxriQuery(
        'terminal.reference.preview',
        {
            terminalId: terminalId ?? '',
            reference: reference ?? { kind: 'github', owner: '', repo: '', number: 1 },
        },
        {
            enabled: terminalId !== undefined && reference !== undefined,
            retry: false,
            staleTime: 5 * 60_000,
        },
    );
    return reference ? trackerPreviewTitle(preview.data) : undefined;
}

/**
 * A pull request, issue, or acceptance report the Agent created or edited this turn, as one clickable card: the
 * tracker's mark in a tile, the title beside its `owner/repo#N`, `ENG-123`, or `Round N` reference, what was done to
 * it, and the body's first line. Opens the page in the browser, which the trailing external arrow says before the
 * click; the edited-files card beside it expands in place and carries no arrow. A GitHub card without a title shows its
 * reference until the reference preview supplies one.
 */
export function AgentChatTrackerCard({ artifact }: { artifact: AgentChatTrackerArtifact }) {
    const Mark = PROVIDER_MARK[artifact.provider];
    const KindIcon = KIND_ICON[artifact.kind];
    const { t } = useTranslation();
    const label = actionLabel(artifact, t);
    const reference = trackerReferenceText(artifact, t);
    const excerpt = trackerExcerptText(artifact, t);
    const previewTitle = useTrackerPreviewTitle(artifact);
    // An acceptance round ingested with `--requirement "$VAR"` carries no readable title; name the report instead of
    // promoting `Round N` to the headline.
    const title =
        artifact.title ??
        previewTitle ??
        (artifact.kind === 'acceptance' ? t('agentChat.tracker.acceptanceTitle') : undefined);
    return (
        <button
            aria-label={t('agentChat.tracker.cardLabel', {
                action: label,
                title: title ?? reference,
                reference,
            })}
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
                        {title ?? reference}
                    </span>
                    {title && (
                        <span className="shrink-0 font-mono text-[11px] text-muted">
                            {reference}
                        </span>
                    )}
                </span>
                {excerpt && (
                    <span className="truncate text-[12px] leading-5 text-muted">{excerpt}</span>
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
