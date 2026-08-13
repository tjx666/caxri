#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');

async function captureManifest(): Promise<string> {
    const child = spawn('bunx', ['playwright', 'test', '--list', '--reporter=list'], {
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
    });
    if (code !== 0) throw new Error(`Could not list the E2E manifest:\n${stderr || stdout}`);
    return stdout.replaceAll('\r\n', '\n').trim();
}

export function summarizeE2EManifest(output: string): { hash: string; tests: number } {
    const total = /Total:\s+(\d+)\s+tests?/u.exec(output)?.[1];
    if (!total) throw new Error('Playwright list output did not include a test total');
    return {
        hash: createHash('sha256').update(output).digest('hex'),
        tests: Number(total),
    };
}

async function main(): Promise<void> {
    const specs = (await readdir(resolve(projectRoot, 'e2e'), { withFileTypes: true })).filter(
        (entry) => entry.isFile() && entry.name.endsWith('.e2e.ts'),
    ).length;
    const manifest = summarizeE2EManifest(await captureManifest());
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        await appendFile(
            summary,
            [
                '## E2E manifest',
                '',
                '| Specs | Tests | SHA-256 |',
                '| ---: | ---: | --- |',
                `| ${specs} | ${manifest.tests} | \`${manifest.hash}\` |`,
                '',
            ].join('\n'),
            'utf8',
        );
    }
    process.stdout.write(
        `E2E manifest: ${specs} specs, ${manifest.tests} tests, sha256=${manifest.hash}\n`,
    );
}

if (import.meta.main) await main();
