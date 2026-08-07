import { relative } from 'node:path';

import type { GitBlame, GitSummary } from '../shared/types';
import type { RuntimeMethodParams } from '../shared/ipc/methods';
import { isOutsideRoot } from './path-security';
import type { ProjectRootResolver } from './project-roots';
import { SingleFlight } from './single-flight';

interface GitBlameServiceOptions {
    git: (
        cwd: string,
        args: string[],
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

    blame(params: RuntimeMethodParams<'git.blame'>): Promise<GitBlame | null> {
        return this.requests.run(JSON.stringify(params), async () => {
            const { path } = await this.paths.resolveSessionPath(params.sessionId, params.path);
            const summary = await this.options.summary(params.sessionId);
            const repository = summary.repositories
                .filter((candidate) => !isOutsideRoot(relative(candidate.rootPath, path)))
                .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
            if (!repository?.head) return null;
            const relativePath = relative(repository.rootPath, path);
            if (!relativePath || isOutsideRoot(relativePath)) return null;
            const output = await this.options.git(
                repository.rootPath,
                [
                    'blame',
                    '--line-porcelain',
                    '-L',
                    `${params.line},${params.line}`,
                    '--',
                    relativePath,
                ],
                { allowFailure: true },
            );
            return parseBlame(output, params.line);
        });
    }
}
