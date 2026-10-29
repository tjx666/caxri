import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished } from 'vitest';

import { renameClaudeSession } from '../../agents/providers/claude/rename';
import { fakeClaudeChatExecutableSource } from './fixtures/fake-chat-executables';
import { FAKE_GENERATED_TITLE, FAKE_GENERATED_TITLE_ZH } from './fixtures/fake-claude-print';

/**
 * Fake Claude's one-shot `--print` modes: the version that clears the low-cost generation and provider rename minimum
 * (2.1.232), a deterministic generated title steered by `naming-*` control files, and the `/rename` JSON result.
 */
async function fixture() {
    // The fake keys its transcript folder on its resolved cwd, so resolve the symlinked macOS temp directory too.
    const created = await mkdtemp(join(tmpdir(), 'caxri-fake-claude-print-'));
    const directory = await realpath(created);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const control = join(directory, 'control');
    const config = join(directory, 'config');
    await mkdir(control);
    await writeFile(join(control, 'ai-naming'), '');
    const executable = join(directory, 'claude');
    await writeFile(
        executable,
        fakeClaudeChatExecutableSource({
            controlDirectory: control,
            claudeConfigDirectory: config,
        }),
    );
    await chmod(executable, 0o755);
    const environment = { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: config };
    const run = (arguments_: string[], input = '') =>
        spawnSync(executable, arguments_, {
            cwd: directory,
            encoding: 'utf8',
            env: environment,
            input,
        });
    const generate = (prompt = '<opening_request>hello</opening_request>') =>
        run(['--print', '--model', 'haiku', '--no-session-persistence'], prompt).stdout.trim();
    return { config, control, directory, environment, executable, generate, run };
}

describe('fake Claude --print', () => {
    it('reports a version that clears the low-cost generation minimum', async () => {
        const { run } = await fixture();
        expect(run(['--version']).stdout).toBe('2.1.232 (Claude Code)\n');
    });

    it('answers SKIP until the ai-naming control file opts in', async () => {
        const { control, generate } = await fixture();
        await rm(join(control, 'ai-naming'));
        expect(generate()).toBe('SKIP');
    });

    it('answers a generation with a fixed title, in Chinese when the prompt asks for it', async () => {
        const { generate } = await fixture();
        expect(generate()).toBe(FAKE_GENERATED_TITLE);
        expect(generate('<title_language>Chinese</title_language>\nhi')).toBe(
            FAKE_GENERATED_TITLE_ZH,
        );
    });

    it('injects a counted SKIP, then an invalid title, then recovers', async () => {
        const { control, generate } = await fixture();
        await writeFile(join(control, 'naming-skip'), '2');
        await writeFile(join(control, 'naming-invalid'), '1');
        expect(generate()).toBe('SKIP');
        expect(generate()).toBe('SKIP');
        expect(generate()).toMatch(/^Title:/u);
        expect(generate()).toBe(FAKE_GENERATED_TITLE);
    });

    it('answers every generation with SKIP while an empty naming-skip file exists', async () => {
        const { control, generate } = await fixture();
        await writeFile(join(control, 'naming-skip'), '');
        expect([generate(), generate(), generate()]).toEqual(['SKIP', 'SKIP', 'SKIP']);
    });

    it('serves the provider rename through /rename and records the custom title', async () => {
        const { config, directory, environment, executable } = await fixture();
        const sessionId = '11111111-1111-4111-8111-111111111111';
        const transcript = join(
            config,
            'projects',
            directory.replaceAll(/[^a-z0-9]/giu, '-'),
            `${sessionId}.jsonl`,
        );
        await mkdir(join(transcript, '..'), { recursive: true });
        await writeFile(transcript, '');
        const result = await renameClaudeSession({
            agentSessionId: sessionId,
            cwd: directory,
            environment: { homeDirectory: directory, variables: environment },
            executable,
            signal: new AbortController().signal,
            title: 'Renamed by provider',
            version: '2.1.232',
        });
        expect(result).toEqual({ title: 'Renamed by provider' });
        expect(await readFile(transcript, 'utf8')).toContain('"customTitle":"Renamed by provider"');
    });
});
