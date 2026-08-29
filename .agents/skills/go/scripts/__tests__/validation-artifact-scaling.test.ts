import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runStateCli } from '../state-cli';
import { createInitialState } from '../state-model';
import {
    prepareRunDirectory,
    readState,
    statePathForRunId,
    writeInitialState,
    writeState,
} from '../state-storage';
import { inspectValidationLog, reconcileValidationArtifacts } from '../validation-artifact';
import { completeValidation, startValidation } from '../validation-gate';
import { runValidation } from '../validation-run';

const cleanupPaths: string[] = [];

afterEach(async () => {
    const paths = [...cleanupPaths];
    cleanupPaths.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
    const worktree = await mkdtemp(join(tmpdir(), 'caxri-validation-artifact-'));
    cleanupPaths.push(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    await writeFile(join(worktree, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(join(worktree, 'source.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: worktree });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktree,
        encoding: 'utf8',
    }).trim();
    const runId = `validation-artifact-${Date.now()}-${process.pid}-${cleanupPaths.length}`;
    const statePath = statePathForRunId(runId);
    cleanupPaths.push(dirname(statePath));
    await prepareRunDirectory(statePath);
    await writeInitialState(
        statePath,
        createInitialState({
            objective: 'Verify bounded validation artifact checks',
            runId,
            worktree: {
                baseSha: headSha,
                createdAt: '2026-08-29T00:00:00.000Z',
                mainCheckoutPath: `${worktree}-main`,
                path: worktree,
            },
        }),
    );
    return { statePath };
}

async function addCompletedValidationArtifacts(statePath: string, count: number): Promise<void> {
    const state = await readState(statePath);
    const runDirectory = dirname(statePath);
    for (let index = 0; index < count; index += 1) {
        const record = startValidation(state, {
            artifactVersion: 1,
            command: `fixture validation ${index}`,
            headSha: state.worktree!.baseSha,
            kind: 'fixture',
            lineageId: `artifact-scaling-${index}`,
            sourceFingerprint: 'fixture-source',
        });
        // eslint-disable-next-line no-await-in-loop -- the fixture preserves receipt ordering
        await writeFile(join(runDirectory, record.logPath), `validation ${index}\n`, 'utf8');
        // eslint-disable-next-line no-await-in-loop -- each receipt must bind its own file metadata
        const receipt = await inspectValidationLog(runDirectory, record.logPath);
        completeValidation(state, {
            clean: true,
            exitCode: 0,
            headSha: state.worktree!.baseSha,
            id: record.id,
            logByteLength: receipt.byteLength,
            logMetadata: receipt.metadata,
            logSha256: receipt.sha256,
            sourceFingerprint: 'fixture-source',
            termination: 'exit',
        });
    }
    await writeState(statePath, state);
}

async function replaceValidationArtifact(statePath: string, index: number): Promise<void> {
    const state = await readState(statePath);
    const original = state.validations[index];
    const replacement = startValidation(state, {
        artifactVersion: 1,
        command: original.command,
        commandDigest: original.commandDigest ?? undefined,
        headSha: original.headSha,
        kind: original.kind,
        lineageId: original.lineageId,
        sourceFingerprint: original.sourceFingerprint,
    });
    const runDirectory = dirname(statePath);
    await writeFile(join(runDirectory, replacement.logPath), 'replacement\n', 'utf8');
    const receipt = await inspectValidationLog(runDirectory, replacement.logPath);
    completeValidation(state, {
        clean: true,
        exitCode: 0,
        headSha: replacement.headSha,
        id: replacement.id,
        logByteLength: receipt.byteLength,
        logMetadata: receipt.metadata,
        logSha256: receipt.sha256,
        sourceFingerprint: replacement.sourceFingerprint,
        termination: 'exit',
    });
    await writeState(statePath, state);
}

describe('Go validation artifact scaling', () => {
    it('bounds ordinary checks while full audits preserve integrity and recovery', async () => {
        const { statePath } = await fixture();
        await addCompletedValidationArtifacts(statePath, 32);
        const state = await readState(statePath);
        const runDirectory = dirname(statePath);

        await expect(reconcileValidationArtifacts(state, runDirectory, 'metadata')).resolves.toBe(
            1,
        );
        await expect(reconcileValidationArtifacts(state, runDirectory, 'full')).resolves.toBe(32);

        const oldestLog = join(runDirectory, state.validations[0].logPath);
        const tampered = await readFile(oldestLog);
        tampered[0] ^= 1;
        await writeFile(oldestLog, tampered);
        await expect(
            runValidation(
                statePath,
                {
                    arguments: ['-e', ''],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'bounded-registration',
                },
                { writeStderr: () => {}, writeStdout: () => {} },
            ),
        ).resolves.toBe(0);
        await runStateCli([
            'note',
            '--state',
            statePath,
            '--kind',
            'workflow',
            '--text',
            '普通读取不扫描旧校验日志。',
        ]);
        const afterOrdinaryWork = JSON.parse(await readFile(statePath, 'utf8')) as {
            validations: Array<{ logIntegrityError: string | null; result: string }>;
        };
        expect(afterOrdinaryWork.validations[0]).toMatchObject({
            logIntegrityError: null,
            result: 'passed',
        });

        await runStateCli(['phase', '--state', statePath, '--phase', 'planning']);
        await runStateCli(['phase', '--state', statePath, '--phase', 'issue_execution']);
        await expect(
            runStateCli(['phase', '--state', statePath, '--phase', 'deep_review']),
        ).rejects.toThrow('has no passed replacement');
        const afterFullAudit = JSON.parse(await readFile(statePath, 'utf8')) as {
            validations: Array<{ logIntegrityError: string | null; result: string }>;
        };
        expect(afterFullAudit.validations[0]).toMatchObject({ result: 'failed' });
        expect(afterFullAudit.validations[0].logIntegrityError).toContain('SHA-256');
        await expect(runStateCli(['validate', '--state', statePath])).rejects.toThrow(
            'artifact is invalid',
        );

        await replaceValidationArtifact(statePath, 0);
        await expect(
            runStateCli(['phase', '--state', statePath, '--phase', 'deep_review']),
        ).resolves.toBeUndefined();
    });

    it('rejects evidence-consuming transitions while a validation is pending', async () => {
        const { statePath } = await fixture();
        const state = await readState(statePath);
        startValidation(state, {
            artifactVersion: 1,
            command: 'pending validation',
            headSha: state.worktree!.baseSha,
            kind: 'fixture',
            lineageId: 'pending-transition',
            sourceFingerprint: 'fixture-source',
        });
        await writeState(statePath, state);

        await runStateCli(['phase', '--state', statePath, '--phase', 'planning']);
        await runStateCli(['phase', '--state', statePath, '--phase', 'issue_execution']);
        await expect(
            runStateCli(['phase', '--state', statePath, '--phase', 'deep_review']),
        ).rejects.toThrow('is still pending');
    });

    it('uses an issue existing commit when completion omits a duplicate commit option', async () => {
        const { statePath } = await fixture();
        await addCompletedValidationArtifacts(statePath, 1);
        const state = await readState(statePath);
        const headSha = state.worktree!.baseSha;
        await runStateCli([
            'issue',
            '--state',
            statePath,
            '--number',
            '447',
            '--title',
            'Fixture issue',
            '--status',
            'committed',
            '--commit',
            headSha,
        ]);
        await runStateCli([
            'drift-assess',
            '--state',
            statePath,
            '--number',
            '447',
            '--head-sha',
            headSha,
            '--kind',
            'internal_detail',
            '--drift-key',
            'fixture-assessment',
        ]);
        const logPath = join(dirname(statePath), state.validations[0].logPath);
        const tampered = await readFile(logPath);
        tampered[0] ^= 1;
        await writeFile(logPath, tampered);

        await expect(
            runStateCli(['issue', '--state', statePath, '--number', '447', '--status', 'complete']),
        ).rejects.toThrow('has no passed replacement');
    });

    it('ignores undeclared head options when finalization audits the recorded PR head', async () => {
        const { statePath } = await fixture();
        await addCompletedValidationArtifacts(statePath, 1);
        const state = await readState(statePath);
        await runStateCli(['pr', '--state', statePath, '--head-sha', state.worktree!.baseSha]);
        const logPath = join(dirname(statePath), state.validations[0].logPath);
        const tampered = await readFile(logPath);
        tampered[0] ^= 1;
        await writeFile(logPath, tampered);

        await expect(
            runStateCli([
                'finalization-delivered',
                '--state',
                statePath,
                '--head-sha',
                'unrelated-head',
            ]),
        ).rejects.toThrow('has no passed replacement');
    });
});
