import { relative } from 'node:path';

import type { RuntimeMethodParams as RuntimeMethodParameters } from '../../shared/ipc/methods';
import type { GitBlame, GitSummary } from '../../shared/types';
import { isOutsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';

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

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly options: GitBlameServiceOptions,
    ) {}

    blame(parameters: RuntimeMethodParameters<'git.blame'>): Promise<GitBlame | null> {
        return this.requests.run(JSON.stringify(parameters), async () => {
            let path: string;
            try {
                ({ path } = await this.paths.resolveSessionPath(
                    parameters.sessionId,
                    parameters.path,
                ));
            } catch (error) {
                /**
                 * A file move can rekey the active editor after this optional blame request starts; a now-missing
                 * target is stale metadata, not an IPC failure.
                 */
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
            const summary = await this.options.summary(parameters.sessionId);
            const repo = summary.repositories
                .filter((candidate) => !isOutsideRoot(relative(candidate.rootPath, path)))
                .toSorted((left, right) => right.rootPath.length - left.rootPath.length)[0];
            if (!repo?.head) return null;
            const relativePath = relative(repo.rootPath, path);
            if (!relativePath || isOutsideRoot(relativePath)) return null;
            const output = await this.options.git(
                repo.rootPath,
                [
                    'blame',
                    '--line-porcelain',
                    '-L',
                    `${parameters.line},${parameters.line}`,
                    '--',
                    relativePath,
                ],
                { allowFailure: true },
            );
            return parseBlame(output, parameters.line);
        });
    }
}
