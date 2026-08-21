import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { ElectronApplication } from 'playwright';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    openBottomPanelView,
    pageRequest,
} from './support/helpers.ts';

async function closeAppQuietly(app: ElectronApplication): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

function transcriptLine(marker: string): string {
    return `${JSON.stringify({ message: marker, type: 'assistant' })}\n`;
}

function claudeFixtureSource(agentSessionId: string): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-claude 1.0.0\n');
  process.exit(0);
}
const now = Date.now();
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, 'current.json'), JSON.stringify({
  cwd: process.cwd(),
  name: 'Transcript Follow Fixture',
  sessionId: ${JSON.stringify(agentSessionId)},
  startedAt: now,
  status: 'busy',
  updatedAt: now,
}));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake claude ready\r\n');
`;
}

test('live transcript updates follow the bottom until the user scrolls away', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-transcript-follow-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const agentSessionId = 'e2e-transcript-follow';
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { executableSource: claudeFixtureSource(agentSessionId) } },
    });
    const launchOptions = { agentMode, userDataDir: userData, testRootPath: root };
    const running = await launchCaxri(launchOptions);
    try {
        const sessionId = await createProjectSession(running.page, 'claude');
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<{
                    terminals: Array<{ agentSessionId?: string; sessionId: string }>;
                }>(running.page, 'app.bootstrap');
                return bootstrap.terminals.find((candidate) => candidate.sessionId === sessionId)
                    ?.agentSessionId;
            })
            .toBe(agentSessionId);
        const bootstrap = await pageRequest<{
            terminals: Array<{ cwd: string; id: string; sessionId: string }>;
        }>(running.page, 'app.bootstrap');
        const terminal = bootstrap.terminals.find((candidate) => candidate.sessionId === sessionId);
        if (!terminal) throw new Error('Claude Terminal fixture was not created');

        const claudeConfigDirectory = agentMode.environment.CLAUDE_CONFIG_DIR;
        if (!claudeConfigDirectory) throw new Error('Fake Claude config directory was not created');
        const transcriptPath = join(
            claudeConfigDirectory,
            'projects',
            terminal.cwd.replaceAll(/[^a-z0-9]/gi, '-'),
            `${agentSessionId}.jsonl`,
        );
        await mkdir(dirname(transcriptPath), { recursive: true });
        const initialContent = Array.from({ length: 300 }, (_, index) =>
            transcriptLine(`initial-${String(index).padStart(3, '0')}`),
        ).join('');
        await writeFile(transcriptPath, initialContent);

        await openBottomPanelView(running.page, 'Info');
        await running.page.getByTitle('Open transcript in the editor').click();
        const editor = running.page.locator('.agent-transcript-editor');
        const content = editor.locator('[data-transcript-following]');
        const scrollable = editor.locator('.monaco-scrollable-element.editor-scrollable');
        await expect(content).toHaveAttribute('data-transcript-following', 'true');
        await expect(editor.locator('.view-lines')).toContainText('initial-299');

        const firstMarker = 'live-marker-one';
        await appendFile(transcriptPath, transcriptLine(firstMarker));
        await expect(content).toHaveAttribute(
            'data-transcript-content-length',
            String(initialContent.length + transcriptLine(firstMarker).length),
        );
        await expect(editor.locator('.view-lines')).toContainText(firstMarker);

        await scrollable.hover();
        await running.page.mouse.wheel(0, -3_000);
        await expect(content).toHaveAttribute('data-transcript-following', 'false');
        const jump = editor.getByRole('button', { name: 'Jump to Latest' });
        await expect(jump).toBeVisible();

        const secondMarker = 'live-marker-two';
        await appendFile(transcriptPath, transcriptLine(secondMarker));
        await expect(content).toHaveAttribute(
            'data-transcript-content-length',
            String(
                initialContent.length +
                    transcriptLine(firstMarker).length +
                    transcriptLine(secondMarker).length,
            ),
        );
        await expect(jump).toBeVisible();
        await expect(editor.locator('.view-lines')).not.toContainText(secondMarker);

        await jump.click();
        await expect(content).toHaveAttribute('data-transcript-following', 'true');
        await expect(editor.locator('.view-lines')).toContainText(secondMarker);

        const thirdMarker = 'live-marker-three';
        await appendFile(transcriptPath, transcriptLine(thirdMarker));
        await expect(editor.locator('.view-lines')).toContainText(thirdMarker);
        await expect(content).toHaveAttribute('data-transcript-following', 'true');
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
