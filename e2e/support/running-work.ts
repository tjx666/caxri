import type { Page } from '@playwright/test';

import { pageRequest } from './helpers.ts';

/**
 * Live PTY Terminals and Chats in the whole app, by kind, as `terminal.runningCount` reports them to the window-close
 * and deletion confirmations.
 */
export function runningWork(page: Page): Promise<{ terminals: number; chats: number }> {
    return pageRequest(page, 'terminal.runningCount');
}
