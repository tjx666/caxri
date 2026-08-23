import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs, promisify } from 'node:util';

import { assertRefactorAcceptancePlan } from './validate-refactor-acceptance';

const execFileAsync = promisify(execFile);

export interface RefactorIssueCreateOptions {
    bodyFile: string;
    labels: readonly string[];
    repo: string;
    title: string;
}

export interface RefactorIssueCreateDependencies {
    makeTemporaryDirectory: (prefix: string) => Promise<string>;
    readBody: (path: string) => Promise<string>;
    removeTemporaryDirectory: (path: string) => Promise<void>;
    reportCleanupFailure: (error: unknown) => void;
    runGitHub: (arguments_: string[]) => Promise<string>;
    temporaryRoot: string;
    writeSnapshot: (path: string, body: string) => Promise<void>;
}

const defaultDependencies: RefactorIssueCreateDependencies = {
    makeTemporaryDirectory: (prefix) => mkdtemp(prefix),
    readBody: (path) => readFile(path, 'utf8'),
    removeTemporaryDirectory: (path) => rm(path, { force: true, recursive: true }),
    reportCleanupFailure: (error) =>
        process.stderr.write(
            `Warning: validated refactor issue snapshot cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
    runGitHub: async (arguments_) => {
        const { stdout } = await execFileAsync('gh', arguments_, { encoding: 'utf8' });
        return stdout;
    },
    temporaryRoot: tmpdir(),
    writeSnapshot: async (path, body) => {
        await writeFile(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
    },
};

/**
 * Freezes the validated body into a private read-only snapshot so the file passed to GitHub cannot diverge from the
 * content that satisfied the refactor parity contract.
 */
export async function createRefactorIssue(
    options: RefactorIssueCreateOptions,
    dependencies: RefactorIssueCreateDependencies = defaultDependencies,
): Promise<string> {
    const body = await dependencies.readBody(options.bodyFile);
    assertRefactorAcceptancePlan(body);
    const temporaryDirectory = await dependencies.makeTemporaryDirectory(
        join(dependencies.temporaryRoot, 'caxri-refactor-issue-'),
    );
    try {
        const snapshot = join(temporaryDirectory, 'body.md');
        await dependencies.writeSnapshot(snapshot, body);
        const output = await dependencies.runGitHub([
            'issue',
            'create',
            '--repo',
            options.repo,
            '--title',
            options.title,
            '--body-file',
            snapshot,
            ...options.labels.flatMap((label) => ['--label', label]),
        ]);
        return output.trim();
    } finally {
        try {
            await dependencies.removeTemporaryDirectory(temporaryDirectory);
        } catch (error: unknown) {
            /**
             * A cleanup failure after GitHub success must not hide the created issue URL and invite a duplicate.
             */
            dependencies.reportCleanupFailure(error);
        }
    }
}

function help(): string {
    return String.raw`Validate and create one refactor issue from the same frozen body

Usage:
  bun run .agents/skills/file-issue/scripts/create-refactor-issue.ts \
    --repo OWNER/REPO --title TITLE --body-file PATH [--label LABEL ...]`;
}

async function main(arguments_: string[]): Promise<void> {
    const { values } = parseArgs({
        args: arguments_,
        options: {
            'body-file': { type: 'string' },
            'help': { type: 'boolean' },
            'label': { multiple: true, type: 'string' },
            'repo': { type: 'string' },
            'title': { type: 'string' },
        },
        strict: true,
    });
    if (values.help) {
        process.stdout.write(`${help()}\n`);
        return;
    }
    if (!values['body-file'] || !values.repo || !values.title)
        throw new Error('--repo, --title, and --body-file are required');
    const url = await createRefactorIssue({
        bodyFile: values['body-file'],
        labels: values.label ?? [],
        repo: values.repo,
        title: values.title,
    });
    process.stdout.write(`${url}\n`);
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
