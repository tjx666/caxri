import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
} from './support/helpers.ts';

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

test('Codex hard-wrapped file paths open as one trusted Terminal link', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-hard-wrap-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(userData, 'e2e-agents', 'home', 'project');
    const target = join(
        root,
        'lobehub-cloud-2-lobe-13558',
        'lobehub',
        'packages',
        'builtin-tool-local-system',
        'src',
        'systemRole.desktop.ts',
    );
    const firstIndependent = join(root, 'first-independent.ts');
    const secondIndependent = join(root, 'second-independent.ts');
    const outsideTarget = join(testDirectory, 'outside-project', 'outside-target.ts');
    const hardWrapScript = join(root, 'emit-codex-hard-wrap.sh');
    const negativeScript = join(root, 'emit-independent-links.sh');
    await Promise.all([
        mkdir(dirname(target), { recursive: true }),
        mkdir(dirname(outsideTarget), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(
            target,
            `${Array.from({ length: 70 }, (_, index) => `target-${String(index + 1).padStart(2, '0')}`).join('\n')}\n`,
        ),
        writeFile(firstIndependent, 'first-1\nfirst-2\n'),
        writeFile(secondIndependent, 'second-1\nsecond-2\nsecond-3\n'),
        writeFile(outsideTarget, 'outside content must remain unread\n'),
    ]);
    const [emittedTarget, emittedFirstIndependent, emittedSecondIndependent, emittedOutsideTarget] =
        await Promise.all([
            realpath(target),
            realpath(firstIndependent),
            realpath(secondIndependent),
            realpath(outsideTarget),
        ]);
    const splitIndex = emittedTarget.indexOf('lobe-13558');
    const firstFragment = emittedTarget.slice(0, splitIndex);
    const continuation = `${emittedTarget.slice(splitIndex)}:56:7`;
    const fullLink = `${emittedTarget}:56:7`;
    await Promise.all([
        writeFile(
            hardWrapScript,
            `#!/bin/sh\nprintf '%s\\n' ${shellQuote(firstFragment)}\nprintf '  %s\\n' ${shellQuote(continuation)}\n`,
        ),
        writeFile(
            negativeScript,
            `#!/bin/sh\nprintf '%s\\n' ${shellQuote(`${emittedFirstIndependent}:2`)}\nprintf '  %s\\n' ${shellQuote(`${emittedSecondIndependent}:3`)}\nprintf '%s\\n' ${shellQuote(emittedOutsideTarget)}\n`,
        ),
    ]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root]) },
    });
    try {
        await createShellSession(running.page);
        await typeTerminal(running.page, 'sh ./emit-codex-hard-wrap.sh');
        await expect(running.page.locator('.xterm-rows')).toContainText(firstFragment);
        await expect(running.page.locator('.xterm-rows')).toContainText(continuation);

        await clickTerminalLink(running.page, 'systemRole.desktop.ts:56:7');
        await expect(
            running.page.getByRole('tab', { name: 'systemRole.desktop.ts' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(running.page.getByLabel(/^Editor position: Ln 56, Col 7/)).toBeVisible();
        await expect(
            running.page.locator('.monaco-editor').first().locator('.view-lines'),
        ).toContainText('target-56');

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        /**
         * Opening the Editor unmounts xterm. Returning to the Shell creates a new xterm instance whose persisted buffer
         * arrives asynchronously, so wait for restored content before asking the picker to scan that buffer.
         */
        await expect(running.page.locator('.xterm-rows')).toContainText(continuation);
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await running.page.keyboard.press('Meta+Shift+O');
        const picker = running.page.getByRole('dialog', { name: 'Open Detected Link' });
        const search = picker.getByPlaceholder('Search links in the Terminal…');
        await search.fill(fullLink);
        await expect(
            picker.getByRole('option', { name: `Open file link ${fullLink}`, exact: true }),
        ).toHaveCount(1);
        await expect(
            picker.getByRole('option', {
                name: `Open file link ${firstFragment}`,
                exact: true,
            }),
        ).toHaveCount(0);
        await search.press('Enter');
        await expect(running.page.getByLabel(/^Editor position: Ln 56, Col 7/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await typeTerminal(running.page, 'sh ./emit-independent-links.sh');
        await expect(running.page.locator('.xterm-rows')).toContainText('first-independent.ts:2');
        await expect(running.page.locator('.xterm-rows')).toContainText('second-independent.ts:3');
        const beforeDenied = await pageRequest<{ projects: unknown[]; sessions: unknown[] }>(
            running.page,
            'app.bootstrap',
        );

        await clickTerminalLink(running.page, 'first-independent.ts:2');
        await expect(
            running.page.getByRole('tab', { name: 'first-independent.ts' }),
        ).toHaveAttribute('aria-selected', 'true');
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await clickTerminalLink(running.page, 'second-independent.ts:3');
        await expect(
            running.page.getByRole('tab', { name: 'second-independent.ts' }),
        ).toHaveAttribute('aria-selected', 'true');

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await clickTerminalLink(running.page, 'target.ts');
        await expect(
            running.page
                .locator('.toast')
                .filter({ hasText: 'Terminal link target is outside every Project' }),
        ).toBeVisible();
        const afterDenied = await pageRequest<{ projects: unknown[]; sessions: unknown[] }>(
            running.page,
            'app.bootstrap',
        );
        expect(afterDenied.projects).toHaveLength(beforeDenied.projects.length);
        expect(afterDenied.sessions).toHaveLength(beforeDenied.sessions.length);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
