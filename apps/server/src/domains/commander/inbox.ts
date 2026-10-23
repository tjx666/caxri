import { randomUUID } from 'node:crypto';

import type {
    CommanderInbox,
    CommanderInboxAddInput,
    CommanderInboxCloseReason,
    CommanderInboxItem,
    CommanderInboxPullRequestLive,
    CommanderInboxReplySource,
    ServerEvent,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError, logEventCatalog, parseCommanderInboxPullRequestUrl } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase, StoredCommanderInboxItem } from '../db';
import type { ExternalStatusRunner, GitHubPullRequestStore } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import { mergeGitHubPullRequestAt } from '../git';
import { parseGitHubPullRequest } from '../project-status';
import type { CommanderInboxNoticeEvent } from './notice-text';

/**
 * How often open `merge` items are reconciled against GitHub, and the record age each read accepts. Matching the two
 * lets the shared pull-request store answer from a record another surface fetched moments ago.
 */
const COMMANDER_INBOX_REFRESH_MS = 60_000;
/**
 * `commanderInbox.changed` payload cap from `packages/protocol/src/registry/events.ts`.
 */
const CHANGED_EVENT_MAX_IDS = 64;

export interface CommanderInboxServiceOptions {
    database: CaxriDatabase;
    github: Pick<GitHubPullRequestStore, 'forget' | 'view'>;
    /**
     * `projectStatus.ignoredChecks`, so a `merge` card's check state agrees with the Status panel's.
     */
    ignoredChecks(): readonly string[];
    logger: StructuredLogger;
    now?: () => number;
    /**
     * Queues a content-free notice for the Commander.
     */
    notify(itemId: string, event: CommanderInboxNoticeEvent): void;
    /**
     * Drops every queued Inbox notice once the items they name are deleted.
     */
    forgetNotices(): void;
    refreshIntervalMs?: number;
    run: ExternalStatusRunner;
    send(event: ServerEvent): void;
    /**
     * Working directory for `gh`. Any directory works because every call names its repository with `--repo`.
     */
    workingDirectory: string;
}

/**
 * The owner-facing close reasons that the Commander did not cause itself, and so must hear about.
 */
const NOTICE_FOR_CLOSE: Partial<Record<CommanderInboxCloseReason, CommanderInboxNoticeEvent>> = {
    dismissed: 'dismissed',
    merged: 'merged',
    pullRequestClosed: 'pullRequestClosed',
};

/**
 * Owns the Commander Inbox: what the Commander explicitly raised for the owner, the owner's replies, and the owner's
 * merges. Items and replies are durable; GitHub's live view of each `merge` item's pull request is memory only and
 * reconciled on a schedule by pull-request identity, independent of any Session. A failed read never closes an item.
 * See `docs/agent-commander.md#commander-inbox`.
 */
export class CommanderInboxService {
    private readonly live = new Map<string, CommanderInboxPullRequestLive>();

    private readonly merging = new Set<string>();

    private timer: NodeJS.Timeout | undefined;

    private refreshing: Promise<void> | undefined;

    constructor(private readonly options: CommanderInboxServiceOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private get model() {
        return this.options.database.commanderInbox;
    }

    private present(item: StoredCommanderInboxItem): CommanderInboxItem {
        const live = item.status === 'open' ? this.live.get(item.id) : undefined;
        return live ? { ...item, pullRequestLive: live } : item;
    }

    private require(id: string): StoredCommanderInboxItem {
        const item = this.model.get(id);
        if (!item) throw new CaxriError('NOT_FOUND', 'Inbox item not found');
        return item;
    }

    /**
     * Sends the change in batches the event contract accepts (at most 64 IDs), since a sweep right after a Server start
     * reports every open merge item at once.
     */
    private changed(itemIds: readonly string[]): void {
        for (let start = 0; start < itemIds.length; start += CHANGED_EVENT_MAX_IDS)
            this.options.send({
                event: 'commanderInbox.changed',
                payload: { itemIds: itemIds.slice(start, start + CHANGED_EVENT_MAX_IDS) },
            });
    }

    private closeItem(
        item: StoredCommanderInboxItem,
        reason: CommanderInboxCloseReason,
    ): StoredCommanderInboxItem {
        const now = this.now();
        if (!this.model.close(item.id, reason, now)) return item;
        this.live.delete(item.id);
        this.options.logger.write('info', logEventCatalog.agentCommander.inboxItemClosed, {
            fields: {
                itemId: item.id,
                kind: item.kind,
                reason,
                openMs: now - item.createdAt,
                replyCount: item.replies.length,
            },
        });
        const notice = NOTICE_FOR_CLOSE[reason];
        if (notice) this.options.notify(item.id, notice);
        this.changed([item.id]);
        return this.require(item.id);
    }

    private async runRefresh(): Promise<void> {
        const items = this.model.openMergeItems();
        const openIds = new Set(items.map((item) => item.id));
        for (const id of this.live.keys()) if (!openIds.has(id)) this.live.delete(id);
        const changed: string[] = [];
        // Serial on purpose: a parallel sweep would burst the shared `gh` quota.
        for (const item of items) {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- serial on purpose, see above
            const isChanged = await this.refreshItem(item, false); // eslint-disable-line no-await-in-loop -- see above
            if (isChanged) changed.push(item.id);
        }
        this.changed(changed);
    }

    /**
     * Reads one `merge` item's pull request and applies what GitHub reports: merged or closed elsewhere closes the
     * item, and a head other than the verified one marks it stale. Returns whether the item or its live view changed.
     * Closing emits its own change event.
     */
    private async refreshItem(item: StoredCommanderInboxItem, isForced: boolean): Promise<boolean> {
        if (!item.pullRequest) return false;
        const { owner, repo, number } = parseCommanderInboxPullRequestUrl(item.pullRequest.url);
        let pullRequest: ReturnType<typeof parseGitHubPullRequest>['pullRequest'];
        try {
            const json = await this.options.github.view({
                owner,
                repo,
                number,
                cwd: this.options.workingDirectory,
                maxAgeMs: isForced
                    ? 0
                    : (this.options.refreshIntervalMs ?? COMMANDER_INBOX_REFRESH_MS),
                allowStaleOnFailure: false,
            });
            pullRequest = json
                ? parseGitHubPullRequest(json, this.options.ignoredChecks()).pullRequest
                : undefined;
        } catch (error) {
            this.options.logger.write(
                'warn',
                logEventCatalog.agentCommander.inboxPullRequestRefreshFailed,
                {
                    fields: {
                        itemId: item.id,
                        kind: error instanceof ExternalStatusCliError ? error.kind : 'unknown',
                    },
                },
            );
            return this.live.delete(item.id);
        }
        if (!pullRequest) return this.live.delete(item.id);
        const current = this.model.get(item.id);
        if (current?.status !== 'open') return false;
        if (pullRequest.lifecycle === 'merged') {
            this.closeItem(current, 'merged');
            return false;
        }
        if (pullRequest.lifecycle === 'closed') {
            this.closeItem(current, 'pullRequestClosed');
            return false;
        }
        const live: CommanderInboxPullRequestLive = {
            title: pullRequest.title.slice(0, 1_000),
            lifecycle: pullRequest.lifecycle ?? 'open',
            checks: pullRequest.state,
            ...(pullRequest.mergeState && { mergeState: pullRequest.mergeState }),
            ...(pullRequest.headSha && { headSha: pullRequest.headSha }),
            refreshedAt: this.now(),
        };
        const previous = this.live.get(item.id);
        this.live.set(item.id, live);
        let isChanged = !previous || !isSameLive(previous, live);
        if (pullRequest.headSha) {
            const reason =
                pullRequest.headSha === current.pullRequest?.headSha ? undefined : 'headMoved';
            if (this.model.setStale(item.id, reason, this.now())) {
                isChanged = true;
                this.options.logger.write(
                    'info',
                    logEventCatalog.agentCommander.inboxStaleChanged,
                    {
                        fields: { itemId: item.id, reason: reason ?? null },
                    },
                );
            }
        }
        return isChanged;
    }

    /**
     * Re-announces every reply the Commander has not acknowledged, since notices queued before a restart lived only in
     * memory, then starts the pull-request reconcile loop.
     */
    start(): void {
        this.announceUnacknowledged();
        this.timer = setInterval(() => {
            void this.refresh();
        }, this.options.refreshIntervalMs ?? COMMANDER_INBOX_REFRESH_MS);
        this.timer.unref();
        void this.refresh();
    }

    /**
     * Queues a reply notice for every open item whose latest reply the Commander has not acknowledged. Called at Server
     * start and right before the Commander process starts, so its launch prompt carries them.
     */
    announceUnacknowledged(): void {
        for (const { id } of this.model.unacknowledged()) this.options.notify(id, 'replied');
    }

    close(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    list(isClosedIncluded = false): CommanderInbox {
        return {
            generatedAt: this.now(),
            items: this.model.list(isClosedIncluded).map((item) => this.present(item)),
        };
    }

    show(id: string): CommanderInboxItem {
        return this.present(this.require(id));
    }

    add(input: CommanderInboxAddInput): CommanderInboxItem {
        if (input.kind === 'merge') {
            if (!input.pullRequest)
                throw new CaxriError('VALIDATION', 'A merge item needs --pr and --head');
            if (input.key)
                throw new CaxriError('VALIDATION', 'A merge item is keyed by its pull request');
        } else if (input.pullRequest) {
            throw new CaxriError('VALIDATION', 'Only a merge item names a pull request');
        }
        const key = input.kind === 'merge' ? input.pullRequest!.url : input.key;
        const values = {
            title: input.title,
            body: input.body,
            options: input.options,
            sessionId: input.sessionId,
            delegationId: input.delegationId,
            pullRequest: input.pullRequest,
        };
        const now = this.now();
        const existing = key === undefined ? undefined : this.model.findOpen(input.kind, key);
        const item = existing
            ? this.model.replace(existing.id, values, now)
            : this.model.insert(randomUUID(), input.kind, key, values, now);
        this.options.logger.write('info', logEventCatalog.agentCommander.inboxItemReported, {
            fields: {
                itemId: item.id,
                kind: item.kind,
                outcome: existing ? 'updated' : 'added',
            },
        });
        this.changed([item.id]);
        if (item.kind === 'merge')
            void this.refreshItem(item, true).then((changed) => changed && this.changed([item.id]));
        return this.present(item);
    }

    /**
     * Idempotent: resolving a closed item returns it unchanged.
     */
    resolve(id: string): CommanderInboxItem {
        return this.present(this.closeItem(this.require(id), 'resolved'));
    }

    acknowledge(id: string, sequence: number): CommanderInboxItem {
        const item = this.require(id);
        const latest = item.replies.at(-1)?.sequence ?? 0;
        if (sequence > latest)
            throw new CaxriError('VALIDATION', `Inbox item ${id} has no reply ${sequence}`);
        if (this.model.acknowledge(id, sequence, this.now())) this.changed([id]);
        return this.show(id);
    }

    reply(id: string, body: string, source: CommanderInboxReplySource): CommanderInboxItem {
        const sequence = this.model.appendReply(id, body, source, this.now());
        const item = this.require(id);
        this.options.logger.write('info', logEventCatalog.agentCommander.inboxReplied, {
            fields: { itemId: id, kind: item.kind, sequence, source },
        });
        this.options.notify(id, 'replied');
        this.changed([id]);
        return this.present(item);
    }

    /**
     * Idempotent like {@link resolve}.
     */
    dismiss(id: string): CommanderInboxItem {
        return this.present(this.closeItem(this.require(id), 'dismissed'));
    }

    /**
     * Deletes every item with its replies for Clear Commander Data. Nothing is announced to the Commander: the user,
     * not the Commander, chose to forget these, and an unacknowledged reply has nothing left to point at.
     */
    clear(): number {
        const ids = this.model.deleteAll();
        this.live.clear();
        this.options.forgetNotices();
        this.changed(ids);
        return ids.length;
    }

    counts(): { open: number; closed: number } {
        return this.model.counts();
    }

    /**
     * Merges a `merge` item's pull request pinned to the head the Commander verified, then closes the item. The
     * revision check makes the owner's click apply only to the report they read: the Commander replacing it, a moved
     * head, or a concurrent close all refuse instead of merging on old evidence.
     */
    async merge(
        id: string,
        revision: number,
    ): Promise<ServerOperationResult<'commander.inbox.merge'>> {
        const item = this.require(id);
        if (item.kind !== 'merge' || !item.pullRequest)
            throw new CaxriError('VALIDATION', 'Only a merge item can be merged');
        if (item.status !== 'open') throw new CaxriError('CONFLICT', 'This Inbox item is closed');
        if (item.revision !== revision)
            throw new CaxriError(
                'CONFLICT',
                'The Commander updated this item since you opened it; review it again',
            );
        if (item.staleReason)
            throw new CaxriError(
                'CONFLICT',
                'The pull request changed after the Commander verified it; wait for it to re-verify',
            );
        if (this.merging.has(id)) throw new CaxriError('CONFLICT', 'A merge is already running');
        this.merging.add(id);
        try {
            const { owner, repo, number, headSha } = item.pullRequest;
            const { method } = await mergeGitHubPullRequestAt(
                { owner, repo, number, headSha, cwd: this.options.workingDirectory },
                {
                    forget: (...identity) => this.options.github.forget(...identity),
                    logger: this.options.logger,
                    run: this.options.run,
                },
            );
            const closed = this.closeItem(this.require(id), 'merged');
            return { item: this.present(closed), method };
        } finally {
            this.merging.delete(id);
        }
    }

    /**
     * Reconciles every open `merge` item. Single-flight, and serial inside, so a slow GitHub never stacks sweeps or
     * bursts the shared `gh` quota.
     */
    refresh(): Promise<void> {
        this.refreshing ??= (async () => {
            try {
                await this.runRefresh();
            } finally {
                this.refreshing = undefined;
            }
        })();
        return this.refreshing;
    }
}

function isSameLive(a: CommanderInboxPullRequestLive, b: CommanderInboxPullRequestLive): boolean {
    return (
        a.title === b.title &&
        a.lifecycle === b.lifecycle &&
        a.checks === b.checks &&
        a.mergeState === b.mergeState &&
        a.headSha === b.headSha
    );
}
