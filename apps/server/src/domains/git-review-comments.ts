import type { GitReviewComment, ServerEvent } from '@caxri/protocol';
import { CaxriError, reviewSnippet } from '@caxri/protocol';

import type { LongPasteService } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { GitService } from './git';
import { createGitReviewSendHandler } from './git-review-send';
import type { TerminalManager } from './terminal';

type GitReviewCommentMethod =
    | 'gitReview.list'
    | 'gitReview.pending'
    | 'gitReview.add'
    | 'gitReview.edit'
    | 'gitReview.remove'
    | 'gitReview.refresh'
    | 'gitReview.clearResolved';

/**
 * Groups pending counts by Session + repository without colliding on either id containing the other's value: both are
 * arbitrary bounded strings (`identifierSchema`), so a NUL separator (never valid inside either) is the only safe join.
 * Mirrors the same NUL-keying convention `git-diff-actions.ts`'s `registrationKey` already uses.
 */
function scopeKey(sessionId: string, repoId: string): string {
    return `${sessionId}\u{0}${repoId}`;
}

/**
 * Server-owned, in-memory store for Git diff review comments, scoped by Session + repository. Deliberately not durable:
 * see `docs/git-diff-review.md` for the accepted restart limitation this store carries in exchange for a future mobile
 * client sharing the same data through the gateway instead of duplicating Desktop Renderer state.
 */
export class GitReviewCommentStore {
    private readonly comments = new Map<string, GitReviewComment>();

    constructor(private readonly send: (event: ServerEvent) => void) {}

    private emitChanged(sessionId: string, repoId: string): void {
        this.send({ event: 'gitReview.changed', payload: { sessionId, repositoryId: repoId } });
    }

    list(sessionId: string, repoId: string): GitReviewComment[] {
        return this.comments
            .values()
            .filter((comment) => comment.sessionId === sessionId && comment.repositoryId === repoId)
            .toArray();
    }

    /**
     * Pending counts grouped by Session + repository, with no repository name attached: the store holds no Git state,
     * so the `gitReview.pending` handler enriches each group with a display name itself.
     */
    pendingCounts(): Array<{ sessionId: string; repositoryId: string; count: number }> {
        const counts = new Map<
            string,
            { sessionId: string; repositoryId: string; count: number }
        >();
        for (const comment of this.comments.values()) {
            if (comment.status !== 'pending') continue;
            const key = scopeKey(comment.sessionId, comment.repositoryId);
            const existing = counts.get(key);
            if (existing) existing.count += 1;
            else
                counts.set(key, {
                    sessionId: comment.sessionId,
                    repositoryId: comment.repositoryId,
                    count: 1,
                });
        }
        return counts.values().toArray();
    }

    add(comment: GitReviewComment): GitReviewComment {
        this.comments.set(comment.id, comment);
        this.emitChanged(comment.sessionId, comment.repositoryId);
        return comment;
    }

    /**
     * Editing a sent or outdated comment's text has to make it sendable again, or the correction silently never reaches
     * the Agent: resetting to `pending` here is a no-op for an already-pending comment and otherwise clears the
     * resolved state the stale text earned.
     */
    edit(id: string, text: string): GitReviewComment {
        const existing = this.comments.get(id);
        if (!existing) throw new CaxriError('NOT_FOUND', 'Review comment not found');
        const updated: GitReviewComment = { ...existing, text, status: 'pending' };
        this.comments.set(id, updated);
        this.emitChanged(updated.sessionId, updated.repositoryId);
        return updated;
    }

    remove(id: string): void {
        const existing = this.comments.get(id);
        if (!existing) return;
        this.comments.delete(id);
        this.emitChanged(existing.sessionId, existing.repositoryId);
    }

    markSent(ids: readonly string[]): void {
        const scopes = new Map<string, { sessionId: string; repositoryId: string }>();
        for (const id of ids) {
            const existing = this.comments.get(id);
            if (!existing) continue;
            this.comments.set(id, { ...existing, status: 'sent' });
            scopes.set(scopeKey(existing.sessionId, existing.repositoryId), {
                sessionId: existing.sessionId,
                repositoryId: existing.repositoryId,
            });
        }
        for (const scope of scopes.values()) this.emitChanged(scope.sessionId, scope.repositoryId);
    }

    clearResolved(sessionId: string, repoId: string): void {
        let isChanged = false;
        for (const [id, comment] of this.comments) {
            if (comment.sessionId !== sessionId || comment.repositoryId !== repoId) continue;
            if (comment.status === 'pending') continue;
            this.comments.delete(id);
            isChanged = true;
        }
        if (isChanged) this.emitChanged(sessionId, repoId);
    }

    /**
     * A changed anchor is invalidated instead of migrating silently to an unrelated line.
     */
    refresh(
        sessionId: string,
        repoId: string,
        sourceKey: string,
        path: string,
        side: GitReviewComment['side'],
        content: string,
    ): void {
        let isChanged = false;
        for (const [id, comment] of this.comments) {
            if (
                comment.sessionId !== sessionId ||
                comment.repositoryId !== repoId ||
                comment.sourceKey !== sourceKey ||
                comment.path !== path ||
                comment.side !== side ||
                comment.status !== 'pending'
            )
                continue;
            if (reviewSnippet(content, comment.startLine, comment.endLine) === comment.snippet)
                continue;
            this.comments.set(id, { ...comment, status: 'outdated' });
            isChanged = true;
        }
        if (isChanged) this.emitChanged(sessionId, repoId);
    }
}

/**
 * Wires the store's CRUD surface to the public `gitReview.*` methods that own reads and mutations (not the Terminal
 * send, which lives in `git-review-send.ts` because it needs the Terminal and long-paste domains too).
 */
export function createGitReviewCommentHandlers(
    store: GitReviewCommentStore,
    git: Pick<GitService, 'repositoryIdentity'>,
): Pick<DomainHandlers, GitReviewCommentMethod> {
    return {
        'gitReview.list': ({ sessionId, repositoryId }) => store.list(sessionId, repositoryId),
        'gitReview.pending': async () => {
            const groups = await Promise.all(
                store.pendingCounts().map(async (group) => {
                    let repoName: string;
                    try {
                        repoName = (
                            await git.repositoryIdentity(group.sessionId, group.repositoryId)
                        ).name;
                    } catch {
                        repoName = group.repositoryId;
                    }
                    return { ...group, repositoryName: repoName };
                }),
            );
            return { count: groups.reduce((sum, group) => sum + group.count, 0), groups };
        },
        'gitReview.add': (parameters) => store.add({ ...parameters, text: '', status: 'pending' }),
        'gitReview.edit': ({ id, text }) => store.edit(id, text),
        'gitReview.remove': ({ id }) => {
            store.remove(id);
            return null;
        },
        'gitReview.refresh': ({ sessionId, repositoryId, sourceKey, path, side, content }) => {
            store.refresh(sessionId, repositoryId, sourceKey, path, side, content);
            return null;
        },
        'gitReview.clearResolved': ({ sessionId, repositoryId }) => {
            store.clearResolved(sessionId, repositoryId);
            return null;
        },
    };
}

interface GitReviewHandlersOptions {
    database: CaxriDatabase;
    git: Pick<GitService, 'repositoryIdentity'>;
    longPastes: LongPasteService;
    send: (event: ServerEvent) => void;
    terminalInput: DomainHandlers['terminal.input'];
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'writeAgentExact'>;
}

/**
 * Single composition entry point for the whole `gitReview.*` surface (CRUD plus Terminal send), so the Server's
 * composition root only needs one call instead of constructing the store and both handler groups itself.
 */
export function createGitReviewHandlers(
    options: GitReviewHandlersOptions,
): Pick<DomainHandlers, GitReviewCommentMethod | 'gitReview.send'> {
    const store = new GitReviewCommentStore(options.send);
    return {
        ...createGitReviewCommentHandlers(store, options.git),
        'gitReview.send': createGitReviewSendHandler({ ...options, reviewComments: store }),
    };
}
