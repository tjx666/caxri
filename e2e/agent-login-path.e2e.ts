import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { annotateE2ETimings } from '../scripts/reporters/public-e2e-diagnostics.ts';
import { realCodexSmokeArguments } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openAddProjectDialog, pageRequest } from './support/helpers.ts';
import { runningWork } from './support/running-work.ts';

const packagedExecutable = process.env.CAXRI_PACKAGED_EXECUTABLE;

test('Finder-like launch gives a Node-dependent Codex launcher the login-shell PATH and exports', async () => {
    const testInfo = test.info();
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-login-path-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const bin = join(testDirectory, 'login-bin');
    const home = join(testDirectory, 'home');
    const state = join(testDirectory, 'provider-state');
    const loginShell = join(testDirectory, 'zsh');
    const probeLog = join(testDirectory, 'probe.jsonl');
    await Promise.all([mkdir(root), mkdir(bin), mkdir(home), mkdir(state)]);
    await symlink(process.execPath, join(bin, 'node'));
    await writeFile(
        join(bin, 'codex'),
        `#!/bin/sh
exec node "${join(bin, 'codex.js')}" "$@"
`,
        'utf8',
    );
    await writeFile(
        join(bin, 'codex.js'),
        String.raw`const fs = require('node:fs');
const version = process.argv.includes('--version');
fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({
  caxriE2E: process.env.CAXRI_E2E,
  githubToken: process.env.GITHUB_TOKEN,
  path: process.env.PATH,
  shellExported: process.env.SHELL_EXPORTED_API_KEY,
  version,
}) + '\n');
if (version) {
  console.log('codex-login-path 1.0');
} else {
  console.log('Codex login PATH ready');
  setInterval(() => {}, 1000);
}
`,
        'utf8',
    );
    await writeFile(
        loginShell,
        `#!/bin/sh
if [ "$1" = "-lic" ]; then
  export PATH='${bin}:/usr/bin:/bin' SHELL_EXPORTED_API_KEY=from-login-shell
  exec /bin/sh -c "$2"
fi
exec /bin/zsh "$@"
`,
        'utf8',
    );
    await Promise.all([chmod(join(bin, 'codex'), 0o755), chmod(loginShell, 0o755)]);

    const running = await launchCaxri({
        agentMode: { mode: 'real', provider: 'codex' },
        userDataDir: userData,
        testRootPath: root,
        executablePath: packagedExecutable,
        onLaunchStage: (stage, durationMs) =>
            annotateE2ETimings(testInfo, 'agentLaunch', { [stage]: durationMs }),
        env: {
            HOME: home,
            CODEX_HOME: state,
            CODEX_SQLITE_HOME: state,
            GITHUB_TOKEN: 'must-not-reach-agent',
            PATH: '/usr/bin:/bin',
            SHELL: loginShell,
        },
    });
    try {
        if (packagedExecutable) {
            await running.app.evaluate(({ dialog }, projectRoot) => {
                dialog.showOpenDialog = () =>
                    Promise.resolve({ canceled: false, filePaths: [projectRoot] });
            }, root);
        }
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                'agents.providers': {
                    codex: {
                        hooks: { enabled: false },
                        launch: {
                            executable: 'codex',
                            args: realCodexSmokeArguments(
                                'Report that the synthetic login-path launcher is ready. Do not modify files.',
                            ),
                        },
                    },
                },
            }),
        });
        await openAddProjectDialog(running.page);
        await running.page.getByRole('dialog').getByRole('button', { name: 'Codex' }).click();

        await expect(running.page.getByRole('tab', { name: 'Codex' })).toBeVisible();
        await expect(
            running.page.locator('.terminal-surface[data-terminal-attached="true"]'),
        ).toBeVisible();
        await expect(running.page.locator('.xterm-rows')).toContainText('Codex login PATH ready');
        await expect.poll(() => runningWork(running.page)).toEqual({ terminals: 1, chats: 0 });
        await expect
            .poll(async () => {
                const records = (await readFile(probeLog, 'utf8'))
                    .trim()
                    .split('\n')
                    .filter(Boolean)
                    .map(
                        (line) =>
                            JSON.parse(line) as {
                                caxriE2E?: string;
                                githubToken?: string;
                                path?: string;
                                shellExported?: string;
                                version: boolean;
                            },
                    );
                return {
                    filtered: records.every((record) => !record.caxriE2E && !record.githubToken),
                    path: records.at(0)?.path,
                    shellExported: records.find((record) => !record.version)?.shellExported,
                    running: records.some((record) => !record.version),
                    version: records.some((record) => record.version),
                };
            })
            .toEqual({
                filtered: true,
                path: `${bin}:/usr/bin:/bin`,
                shellExported: 'from-login-shell',
                running: true,
                version: true,
            });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
