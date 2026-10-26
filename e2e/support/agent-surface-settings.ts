import type { AppSettings } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { pageRequest } from './helpers.ts';

/**
 * Opens Agents in a Terminal instead of Chat. Agents open in Chat by default, which relabels the create-menu entries to
 * "<Agent> Chat"; specs that drive the PTY Agent surface call this right after launch.
 */
export async function openAgentsInTerminal(page: Page): Promise<void> {
    const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
    await pageRequest(page, 'settings.update', {
        source: JSON.stringify({ ...current.value, 'session.openAgentsInChat': false }, null, 2),
    });
}
