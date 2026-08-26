import { relative } from 'node:path';

import type {
    GitBlame,
    GitCommit,
    GitSummary,
    RuntimeMethodParams as RuntimeMethodParameters,
} from '@caxri/protocol';

import { isOutsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import { COMMIT_FORMAT, parseCommitLog } from './commit-log';

interface GitBlameServiceOptions {
    git: (
        cwd: string,
        arguments_: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ) => Promise<string>;
    summary: (sessionId: string) => Promise<GitSummary>;
}

function parseBlame(output: string, requestedLine: number): GitBlame | null {
    const lines = output.split('\n');
    const header = /^\^?([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(lines[0] ?? '');
    if (!header) return null;
    const field = (name: string): string | undefined =>
        lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    const authoredAt = Number(field('author-time')) * 1_000;
    const author = field('author');
    if (!author || !Number.isFinite(authoredAt)) return null;
    const sha = header[1];
    return {
        sha,
        author,
        authoredAt,
        subject: field('summary') ?? '',
        line: Number(header[2]) || requestedLine,
        uncommitted: /^0+$/.test(sha),
    };
}

export class GitBlameService {
    private readonly requests = new SingleFlight<string, GitBlame | null>();
    private readonly fileHeads = new SingleFlight<string, GitCommit | null>();

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly options: GitBlameServiceOptions,
    ) {}

    /**
     * Maps a Session-scoped editor path to the innermost repository tracking it, or `null` when the file is gone or
     * outside every known repository — both are stale-metadata outcomes for these optional annotations, not failures.
     */
    private async resolveTrackedPath(
        sessionId: string,
        requestedPath: string,
    ): Promise<{ relativePath: string; rootPath: string } | null> {
        let path: string;
        try {
            ({ path } = await this.paths.resolveSessionPath(sessionId, requestedPath));
        } catch (error) {
            /**
             * A file move can rekey the active editor after this optional blame request starts; a now-missing target is
             * stale metadata, not an IPC failure.
             */
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        const summary = await this.options.summary(sessionId);
        // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: the filtered/sorted
        // list is commonly empty when `path` is outside every known repository.
        const repo = summary.repositories
            .filter((candidate) => !isOutsideRoot(relative(candidate.rootPath, path)))
            .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
            .at(0);
        if (!repo?.head) return null;
        const relativePath = relative(repo.rootPath, path);
        if (!relativePath || isOutsideRoot(relativePath)) return null;
        return { relativePath, rootPath: repo.rootPath };
    }

    blame(parameters: RuntimeMethodParameters<'git.blame'>): Promise<GitBlame | null> {
        return this.requests.run(JSON.stringify(parameters), async () => {
            const target = await this.resolveTrackedPath(parameters.sessionId, parameters.path);
            if (!target) return null;
            const output = await this.options.git(
                target.rootPath,
                [
                    'blame',
                    '--line-porcelain',
                    '-L',
                    `${parameters.line},${parameters.line}`,
                    '--',
                    target.relativePath,
                ],
                { allowFailure: true },
            );
            return parseBlame(output, parameters.line);
        });
    }

    /**
     * Latest commit touching one file — the file-level "who changed this last" annotation shown above the editor.
     */
    fileHead(parameters: RuntimeMethodParameters<'git.fileHead'>): Promise<GitCommit | null> {
        return this.fileHeads.run(JSON.stringify(parameters), async () => {
            const target = await this.resolveTrackedPath(parameters.sessionId, parameters.path);
            if (!target) return null;
            const output = await this.options.git(
                target.rootPath,
                [
                    'log',
                    '-z',
                    '--full-history',
                    '--max-count=1',
                    `--format=${COMMIT_FORMAT}`,
                    '--',
                    target.relativePath,
                ],
                { allowFailure: true },
            );
            return parseCommitLog(output).at(0) ?? null;
        });
    }
}
