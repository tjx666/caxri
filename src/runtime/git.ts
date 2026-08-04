import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { GitFileStatus, GitSummary } from '../shared/types';
import type { FileService } from './files';
import type { StructuredLogger } from './logger';
import { isOutsideRoot } from './path-security';
import { safeProcessEnvironment } from './process-environment';
import { SingleFlight } from './single-flight';

const execFileAsync = promisify(execFile);

export function describeGitFailure(error: unknown): string {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === 'ENOENT') return 'Git is not installed or is unavailable on PATH.';
    if (failure.killed || failure.message?.toLowerCase().includes('timed out'))
        return 'The Git operation timed out.';
    if (
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.message?.includes('maxBuffer')
    ) {
        return 'Git output exceeded the safety limit.';
    }
    if (failure.stderr?.toLowerCase().includes('not a git repository'))
        return 'The Session root is not a Git repository.';
    return 'The Git operation failed. See Runtime logs for details.';
}

function statusKind(code: string): GitFileStatus['kind'] {
    if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
    if (code.includes('R')) return 'renamed';
    if (code.includes('D')) return 'deleted';
    if (code.includes('A')) return 'added';
    return 'modified';
}

function parseStatusRecord(
    record: string,
): { code: string; path: string; kind?: GitFileStatus['kind'] } | undefined {
    if (record.startsWith('? ')) return { code: '??', path: record.slice(2), kind: 'untracked' };
    const ordinary = /^1 (\S{2})(?: \S+){6} (.+)$/.exec(record);
    if (ordinary) return { code: ordinary[1], path: ordinary[2] };
    const renamed = /^2 (\S{2})(?: \S+){7} (.+)$/.exec(record);
    if (renamed) return { code: renamed[1], path: renamed[2], kind: 'renamed' };
    const conflicted = /^u (\S{2})(?: \S+){8} (.+)$/.exec(record);
    if (conflicted) return { code: conflicted[1], path: conflicted[2], kind: 'conflicted' };
    return undefined;
}

export class GitService {
    private readonly summaries = new SingleFlight<string, GitSummary>();

    constructor(
        private readonly files: FileService,
        private readonly logger: StructuredLogger,
    ) {}

    private async git(cwd: string, args: string[]): Promise<string> {
        const startedAt = performance.now();
        try {
            const { stdout } = await execFileAsync('git', args, {
                cwd,
                timeout: 10_000,
                maxBuffer: 8 * 1024 * 1024,
                env: { ...safeProcessEnvironment(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
            });
            this.logger.write('info', 'git.command', {
                durationMs: performance.now() - startedAt,
                fields: { operation: args[0] ?? 'unknown' },
            });
            return stdout;
        } catch (error) {
            this.logger.write('warn', 'git.command_failed', {
                durationMs: performance.now() - startedAt,
                fields: {
                    operation: args[0] ?? 'unknown',
                    error: error instanceof Error ? error.message : 'unknown',
                },
            });
            throw error;
        }
    }

    async summary(sessionId: string): Promise<GitSummary> {
        return this.summaries.run(sessionId, () => this.loadSummary(sessionId));
    }

    private async loadSummary(sessionId: string): Promise<GitSummary> {
        const { root } = await this.files.resolveSessionPath(sessionId);
        try {
            const output = await this.git(root, [
                'status',
                '--porcelain=v2',
                '--branch',
                '-z',
                '--untracked-files=normal',
            ]);
            const records = output.split('\0').filter(Boolean);
            const files: GitFileStatus[] = [];
            let branch = 'detached';
            let head: string | undefined;
            for (let index = 0; index < records.length; index += 1) {
                const record = records[index];
                if (record.startsWith('# branch.head ')) {
                    branch = record.slice('# branch.head '.length);
                    continue;
                }
                if (record.startsWith('# branch.oid ')) {
                    const oid = record.slice('# branch.oid '.length);
                    head = oid === '(initial)' ? undefined : oid.slice(0, 7);
                    continue;
                }
                const parsed = parseStatusRecord(record);
                if (!parsed) continue;
                const code = parsed.code.replaceAll('.', ' ');
                files.push({
                    path: parsed.path,
                    index: code[0],
                    workingTree: code[1],
                    kind: parsed.kind ?? (code === '??' ? 'untracked' : statusKind(code)),
                });
                if (record.startsWith('2 ')) index += 1;
            }
            return { isRepository: true, branch, head, files };
        } catch (error) {
            return {
                isRepository: false,
                files: [],
                error: describeGitFailure(error),
            };
        }
    }

    async diff(sessionId: string, path: string): Promise<string> {
        const { root } = await this.files.resolveSessionPath(sessionId);
        let candidate = isAbsolute(path) ? path : resolve(root, path);
        try {
            candidate = await realpath(candidate);
        } catch {
            // Deleted Git paths no longer resolve; their normalized lexical path remains safe for argv after containment checks.
        }
        const relativePath = relative(root, candidate);
        if (!relativePath || isOutsideRoot(relativePath)) {
            throw new Error('Git path is outside the Session root');
        }
        const summary = await this.summary(sessionId);
        const file = summary.files.find((item) => item.path === relativePath);
        if (file?.kind === 'untracked')
            return 'Untracked file. Caxri does not include file contents in a synthetic diff.';
        if (!file) return '';
        const chunks: string[] = [];
        if (![' ', '?'].includes(file.index)) {
            chunks.push(
                await this.git(root, [
                    'diff',
                    '--cached',
                    '--no-ext-diff',
                    '--no-color',
                    '--',
                    relativePath,
                ]),
            );
        }
        if (![' ', '?'].includes(file.workingTree)) {
            chunks.push(
                await this.git(root, ['diff', '--no-ext-diff', '--no-color', '--', relativePath]),
            );
        }
        return chunks.filter(Boolean).join('\n');
    }
}
