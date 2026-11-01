import process from 'node:process';

import type { Page } from './fixtures.ts';
import { pageRequest, VISIBLE_TERMINAL_INPUT } from './helpers.ts';

/**
 * The Server's record of one Terminal from `app.bootstrap`.
 */
export async function bootstrapTerminal(
    page: Page,
    terminalId: string,
): Promise<
    { lastAgentProcessState?: string; lastProcessState?: string; processId?: number } | undefined
> {
    const bootstrap = await pageRequest<{
        terminals: Array<{
            id: string;
            lastAgentProcessState?: string;
            lastProcessState?: string;
            processId?: number;
        }>;
    }>(page, 'app.bootstrap');
    return bootstrap.terminals.find(({ id }) => id === terminalId);
}

export async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator(VISIBLE_TERMINAL_INPUT).last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

/**
 * A fake Codex that reports readiness, then exits on Ctrl+C after printing `FAKE_CODEX_EXITED`.
 */
export function interruptibleAgentFixture(): string {
    return String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-codex 1.0.0\n');
  process.exit(0);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (!chunk.includes(3)) return;
  process.stdin.setRawMode?.(false);
  process.stdout.write('\r\nFAKE_CODEX_EXITED\r\n', () => process.exit(0));
});
process.stdout.write('FAKE_CODEX_READY\r\n');
`;
}
