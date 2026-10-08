import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
    GitFileStatus,
    GitRepositorySummary as GitRepoSummary,
    ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { isOutsideRoot } from '../path-security';
import type { GitDiscardSnapshot } from './repo';
import { authoritativeGitMutation } from './request-signal';

/**
 * Network-bound Git operations (pull/push) can legitimately take far longer than local metadata commands; this bound
 * only guards against a wedged remote, not a slow one.
 */
const SYNC_TIMEOUT_MS = 120_000;

interface WorkingTreeCommandOptions {
    allowFailure?: boolean;
    timeoutMs?: number;
}

type DiscardPreflightParameters = ServerOperationParameters<'git.discard.preflight'>;
type DiscardPreflightResult = ServerOperationResult<'git.discard.preflight'>;
type DiscardReady = Extract<DiscardPreflightResult, { status: 'ready' }>;

interface PendingDiscardConsent extends Omit<DiscardReady, 'token'> {
    expiresAt: number;
    fingerprint: string;
    repositoryId: string;
    sessionId: string;
}

export interface GitWorkingTreeServiceOptions {
    git: (
        cwd: string,
        arguments_: string[],
        options?: WorkingTreeCommandOptions,
    ) => Promise<string>;
    resolveRepository: (sessionId: string, repoId: string) => Promise<GitRepoSummary>;
    snapshot: (sessionId: string, repoId: string) => Promise<GitDiscardSnapshot>;
    onDidMutate?: (repoRoot: string) => void;
    now?: () => number;
    maximumConsents?: number;
    consentTtlMs?: number;
}

const DEFAULT_CONSENT_TTL_MS = 60_000;
const DEFAULT_MAXIMUM_CONSENTS = 128;

/**
 * Working-tree mutations behind the Git panel's Sync and Discard actions. Every discarded path is re-derived from the
 * Server's own status snapshot: the Renderer's `path` parameter is only a lookup key, so no Renderer-supplied string
 * ever reaches a Git argv.
 */
export class GitWorkingTreeService {
    private readonly consents = new Map<string, PendingDiscardConsent>();
    private readonly consentTtlMs: number;
    private readonly maximumConsents: number;
    private readonly now: () => number;

    constructor(private readonly options: GitWorkingTreeServiceOptions) {
        this.consentTtlMs = options.consentTtlMs ?? DEFAULT_CONSENT_TTL_MS;
        this.maximumConsents = options.maximumConsents ?? DEFAULT_MAXIMUM_CONSENTS;
        this.now = options.now ?? Date.now;
    }

    private async discardAll(repo: GitRepoSummary): Promise<void> {
        if (repo.head) {
            await this.options.git(repo.rootPath, ['reset', '--hard']);
        } else {
            // A repository without commits has nothing to reset to; unstage everything so the
            // subsequent clean removes the files as untracked entries.
            await this.options.git(repo.rootPath, ['rm', '-r', '--cached', '--quiet', '--', '.'], {
                allowFailure: true,
            });
        }
        await this.options.git(repo.rootPath, ['clean', '-fd']);
    }

    private async discardFile(repo: GitRepoSummary, file: GitFileStatus): Promise<void> {
        switch (file.kind) {
            case 'untracked':
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            case 'added':
                await this.options.git(repo.rootPath, ['restore', '--staged', '--', file.path]);
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            case 'renamed': {
                if (!file.originalPath)
                    throw new CaxriError('GIT', 'Git reported a rename without its original path');
                // Restore the pre-rename file (index and working tree), then drop the renamed
                // copy, which the restore demoted to an untracked entry.
                await this.options.git(repo.rootPath, ['restore', '--staged', '--', file.path]);
                await this.options.git(repo.rootPath, [
                    'checkout',
                    'HEAD',
                    '--',
                    file.originalPath,
                ]);
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            }
            default:
                // `checkout <commit> -- <path>` restores both the index and the working tree, so
                // one command covers staged and unstaged modifications, deletions, and conflicts.
                await this.options.git(repo.rootPath, ['checkout', 'HEAD', '--', file.path]);
        }
    }

    private pruneConsents(): void {
        const now = this.now();
        for (const [token, consent] of this.consents)
            if (consent.expiresAt <= now) this.consents.delete(token);
    }

    private issueConsent(
        snapshot: GitDiscardSnapshot,
        sessionId: string,
        repoId: string,
        scope: DiscardReady['scope'],
    ): DiscardReady {
        this.pruneConsents();
        if (this.consents.size >= this.maximumConsents)
            throw new CaxriError('CAPACITY', 'Too many Git discard confirmations are pending');
        const token = randomUUID();
        this.consents.set(token, {
            expiresAt: this.now() + this.consentTtlMs,
            fingerprint: snapshot.fingerprint,
            repositoryId: repoId,
            repositoryName: snapshot.repository.name,
            scope,
            sessionId,
            status: 'ready',
        });
        return {
            status: 'ready',
            token,
            repositoryName: snapshot.repository.name,
            scope,
        };
    }

    private async snapshotForApply(token: string): Promise<{
        consent: PendingDiscardConsent;
        snapshot: GitDiscardSnapshot;
    }> {
        this.pruneConsents();
        const consent = this.consents.get(token);
        if (!consent)
            throw new CaxriError('CONFLICT', 'Git discard confirmation is missing or expired');
        // Consume before any await so concurrent or replayed apply calls can never both mutate the repository.
        this.consents.delete(token);
        if (consent.expiresAt <= this.now())
            throw new CaxriError('CONFLICT', 'Git discard confirmation is missing or expired');
        const snapshot = await this.options.snapshot(consent.sessionId, consent.repositoryId);
        if (snapshot.fingerprint !== consent.fingerprint)
            throw new CaxriError(
                'CONFLICT',
                'Git working-tree changes changed after confirmation; refresh before discarding',
            );
        return { consent, snapshot };
    }

    /**
     * Produces the only confirmation projection that may reach Desktop Main. Renderer-provided display fields are
     * deliberately absent from this request; Server derives repository name, count, path, and tracked semantics from
     * the complete authorized status stream.
     */
    async discardPreflight(
        parameters: DiscardPreflightParameters,
    ): Promise<DiscardPreflightResult> {
        const snapshot = await this.options.snapshot(parameters.sessionId, parameters.repositoryId);
        if (snapshot.files.length > 100_000)
            throw new CaxriError('CAPACITY', 'Git working-tree changes exceed the discard limit');
        if (parameters.scope.kind === 'all') {
            if (snapshot.files.length === 0) return { status: 'noop' };
            return this.issueConsent(snapshot, parameters.sessionId, parameters.repositoryId, {
                kind: 'all',
                fileCount: snapshot.files.length,
            });
        }
        const requestedPath = parameters.scope.path;
        const candidate = snapshot.files.find(
            (file) => file.path === requestedPath || file.originalPath === requestedPath,
        );
        if (!candidate) {
            if (
                !isAbsolute(requestedPath) &&
                !isOutsideRoot(
                    relative(
                        snapshot.repository.rootPath,
                        resolve(snapshot.repository.rootPath, requestedPath),
                    ),
                )
            )
                return { status: 'noop' };
            throw new CaxriError('PATH_DENIED', 'Git path is outside the authorized repository');
        }
        if (
            !snapshot.authorizedPaths.includes(candidate.path) &&
            (!candidate.originalPath || !snapshot.authorizedPaths.includes(candidate.originalPath))
        )
            throw new CaxriError('PATH_DENIED', 'Git path is outside the authorized repository');
        return this.issueConsent(snapshot, parameters.sessionId, parameters.repositoryId, {
            kind: 'file',
            path: candidate.path,
            untracked: candidate.kind === 'untracked',
        });
    }

    /**
     * Consumes a preflight token and re-reads the full status fingerprint immediately before any destructive Git argv.
     * A stale, replayed, or status-kind-mismatched token fails closed without running a mutation.
     */
    async discardApply(parameters: ServerOperationParameters<'git.discard.apply'>): Promise<null> {
        const { consent, snapshot } = await this.snapshotForApply(parameters.token);
        if (consent.scope.kind === 'all') {
            if (snapshot.files.length !== consent.scope.fileCount)
                throw new CaxriError(
                    'CONFLICT',
                    'Git working-tree count changed after confirmation',
                );
            await this.discardAll(snapshot.repository);
            this.options.onDidMutate?.(snapshot.repository.rootPath);
            return null;
        }
        const fileScope = consent.scope;
        const file = snapshot.files.find(
            (candidate) =>
                candidate.path === fileScope.path || candidate.originalPath === fileScope.path,
        );
        if (!file || (file.kind === 'untracked') !== fileScope.untracked)
            throw new CaxriError('CONFLICT', 'Git file status changed after confirmation');
        await this.discardFile(snapshot.repository, file);
        this.options.onDidMutate?.(snapshot.repository.rootPath);
        return null;
    }

    /**
     * VS Code-style Sync Changes: integrate the upstream first, then publish local commits.
     */
    async sync(parameters: ServerOperationParameters<'git.sync'>): Promise<null> {
        const repo = await this.options.resolveRepository(
            parameters.sessionId,
            parameters.repositoryId,
        );
        return authoritativeGitMutation(async () => {
            await this.options.git(repo.rootPath, ['pull'], { timeoutMs: SYNC_TIMEOUT_MS });
            await this.options.git(repo.rootPath, ['push'], { timeoutMs: SYNC_TIMEOUT_MS });
            this.options.onDidMutate?.(repo.rootPath);
            return null;
        });
    }
}
