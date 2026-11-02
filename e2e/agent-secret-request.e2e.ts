import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { discoverServerManifest, ServerClient } from '@caxri/client/supervise';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('a secret request minimizes to a counting chip and comes back', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-secret-request-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, `project-${'long-name-'.repeat(8)}`);
    const credentialPath = join(testDirectory, 'credential.json');
    await mkdir(root, { recursive: true });
    // The fake Agent hands over its Endpoint credential so the test can ask for secrets as that Agent would.
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-test 1.0\n');
  process.exit(0);
}
require('node:fs').writeFileSync(${JSON.stringify(credentialPath)}, JSON.stringify({
  hostId: process.env.CAXRI_AGENT_ENDPOINT_HOST_ID,
  endpointId: process.env.CAXRI_AGENT_ENDPOINT_ID,
  generation: Number(process.env.CAXRI_AGENT_ENDPOINT_GENERATION),
  token: process.env.CAXRI_AGENT_ENDPOINT_TOKEN,
}));
process.stdout.write('FAKE_SECRET_AGENT_READY\r\n');
process.stdin.resume();
`,
            },
        },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'codex');
        await expect(page.locator('.xterm-rows')).toContainText('FAKE_SECRET_AGENT_READY');
        const agent = await ServerClient.connect(await discoverServerManifest(userData), 2_000, {
            kind: 'agent',
            ...(JSON.parse(await readFile(credentialPath, 'utf8')) as {
                hostId: string;
                endpointId: string;
                generation: number;
                token: string;
            }),
        });
        try {
            await agent.request('agent.secret.request', {
                name: 'E2E_FIRST_TOKEN',
                reason: 'Deploy the preview',
            });
            const card = page.locator('[data-agent-secret-request]');
            await expect(card).toBeVisible();
            // A long Project title once widened the card's grid track past the card, pushing Save out of the window.
            const cardBox = await card.boundingBox();
            const saveBox = await card
                .getByRole('button', { name: 'Save', exact: true })
                .boundingBox();
            expect(cardBox && saveBox && saveBox.x + saveBox.width).toBeLessThanOrEqual(
                (cardBox?.x ?? 0) + (cardBox?.width ?? 0),
            );
            expect(
                await card.evaluate((element) => element.scrollWidth - element.clientWidth),
            ).toBe(0);
            // The requesting Terminal is already on screen, so Open Session would have nowhere to go.
            await expect(card.getByRole('button', { name: 'Open Session' })).toHaveCount(0);

            await card.getByRole('button', { name: 'Minimize', exact: true }).click();
            await expect(card).toBeHidden();
            const chip = page.getByRole('button', { name: 'Secret requests, 1 waiting. Show' });
            await expect(chip).toBeFocused();

            // A request arriving while minimized raises the count instead of reopening the card.
            await agent.request('agent.secret.request', {
                name: 'E2E_SECOND_TOKEN',
                reason: 'Read the staging logs',
            });
            await expect(
                page.getByRole('button', { name: 'Secret requests, 2 waiting. Show' }),
            ).toBeVisible();
            await expect(card).toBeHidden();

            await page.getByRole('button', { name: 'Secret requests, 2 waiting. Show' }).click();
            await expect(card).toBeVisible();
            const value = card.getByLabel('Value for E2E_FIRST_TOKEN');
            await expect(value).toBeFocused();
            await value.fill('typed-before-minimize');
            await page.keyboard.press('Escape');
            await expect(card).toBeHidden();
            await page.getByRole('button', { name: 'Secret requests, 2 waiting. Show' }).click();
            // Minimizing only hides the card, so a half-typed value is still there on return.
            await expect(value).toHaveValue('typed-before-minimize');

            // Minimizing never declined anything: both requests are still there to answer.
            await card.getByRole('button', { name: 'Decline', exact: true }).click();
            await expect(card).toContainText('E2E_SECOND_TOKEN');
            await card.getByRole('button', { name: 'Decline', exact: true }).click();
            await expect(card).toHaveCount(0);
            await expect(page.getByRole('button', { name: /^Secret requests,/ })).toHaveCount(0);
        } finally {
            agent.close();
        }
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
