import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished } from 'vitest';

import { grokProjectRoot } from '../../../../apps/server/src/domains/agents/providers/grok/paths';
import { readGrokState } from '../../../../apps/server/src/domains/agents/providers/grok/state';
import { grokAcceptanceSource } from './grok-fixture';

const SESSION_ID = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';

describe('Grok acceptance fixture', () => {
    it.each(['special', 'long'] as const)(
        'writes a readable title and preserves it on resume for a %s cwd',
        async (layout) => {
            const temporary = await mkdtemp(join(tmpdir(), 'caxri-grok-fixture-'));
            const root = await realpath(temporary);
            onTestFinished(() => rm(root, { recursive: true, force: true }));
            const longSegments = Array.from(
                { length: 4 },
                (_, index) => `${index}-${'a'.repeat(75)}`,
            );
            const cwd =
                layout === 'special'
                    ? join(root, "work (special)!'*")
                    : join(root, ...longSegments);
            const home = join(root, 'grok');
            const executable = join(root, 'grok-fixture.cjs');
            await mkdir(cwd, { recursive: true });
            await mkdir(join(home, 'hooks'), { recursive: true });
            await writeFile(join(home, 'hooks', 'caxri.json'), JSON.stringify({ hooks: {} }));
            await writeFile(executable, grokAcceptanceSource());

            const run = (arguments_: string[]) =>
                spawnSync(process.execPath, [executable, ...arguments_], {
                    cwd,
                    encoding: 'utf8',
                    env: { ...process.env, GROK_HOME: home },
                    input: 'fixture:exit\n',
                    timeout: 5_000,
                });
            const first = run(['--session-id', SESSION_ID]);
            expect(first.error).toBeUndefined();
            expect(first.status).toBe(0);
            const environment = { homeDirectory: root, variables: { GROK_HOME: home } };
            const project = await grokProjectRoot(await realpath(cwd), environment);
            expect(project).toBeTruthy();
            const summary = join(project!, SESSION_ID, 'summary.json');
            expect(
                await readGrokState({ rootPath: cwd, agentSessionId: SESSION_ID }, environment),
            ).toEqual({
                title: `Synthetic Grok Title ${SESSION_ID.slice(0, 8)}`,
                titleSource: 'automatic',
            });
            await writeFile(summary, JSON.stringify({ generated_title: 'Refreshed Grok title' }));

            const resumed = run(['--resume', SESSION_ID]);
            expect(resumed.error).toBeUndefined();
            expect(resumed.status).toBe(0);
            expect(JSON.parse(await readFile(summary, 'utf8'))).toEqual({
                generated_title: 'Refreshed Grok title',
            });
            expect(
                await readGrokState({ rootPath: cwd, agentSessionId: SESSION_ID }, environment),
            ).toEqual({
                title: 'Refreshed Grok title',
                titleSource: 'automatic',
            });
        },
    );
});
