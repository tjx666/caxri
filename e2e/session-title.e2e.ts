import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Agent output refreshes the Session title without opening Info', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-title-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'bin');
    const state = join(testDirectory, 'codex-state');
    const executable = join(bin, 'codex');
    const database = join(state, 'state_9.sqlite');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(bin, { recursive: true }),
        mkdir(state, { recursive: true }),
    ]);
    const canonicalRoot = await realpath(root);
    await execFileAsync('sqlite3', [
        database,
        `CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            title TEXT,
            updated_at_ms INTEGER,
            tokens_used INTEGER,
            archived INTEGER
        );
        INSERT INTO threads VALUES (
            'agent-session-1',
            '${canonicalRoot}',
            'Codex',
            ${Date.now()},
            0,
            0
        );`,
    ]);
    await writeFile(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-test 1.0\\n'
  exit 0
fi
printf 'Fake Codex ready\\n'
while IFS= read -r line; do
  /usr/bin/sqlite3 "$CODEX_SQLITE_HOME/state_9.sqlite" "UPDATE threads SET title = 'hello', updated_at_ms = updated_at_ms + 1 WHERE id = 'agent-session-1';"
  printf 'received %s\\n' "$line"
done
`,
        'utf8',
    );
    await chmod(executable, 0o700);

    const { app, page } = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CODEX_SQLITE_HOME: state,
        },
    });
    try {
        await page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
        await page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();
        await expect(page.locator('.session-card strong')).toHaveText('Codex');

        const input = page.locator('.xterm-helper-textarea');
        await input.focus();
        await input.pressSequentially('hello');
        await input.press('Enter');

        await expect
            .poll(async () =>
                (
                    await execFileAsync('sqlite3', [database, 'SELECT title FROM threads;'])
                ).stdout.trim(),
            )
            .toBe('hello');
        await expect(page.locator('.session-card strong')).toHaveText('hello');
        await page.getByRole('button', { name: 'Info', exact: true }).click();
        const info = page.locator('.terminal-info-card');
        await expect(info).toHaveCount(1);
        await expect(info).toContainText('agent-session-1');
        await expect(info).toContainText('Title source');
        await expect(info.getByText('PID', { exact: true })).toBeVisible();
    } finally {
        await app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
