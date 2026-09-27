import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

const uiRoot = join(process.cwd(), 'apps/desktop/src/renderer/src/components/ui');

/**
 * Overlays that trap focus and block outside pointer interaction. While one is open the surface behind it is neither
 * visible nor reachable, so an app-wide shortcut firing there would act on something the user cannot see. Each wrapper
 * registers with the shared modal registry that `commands/execute.ts` and `commands/use-command-shortcuts.ts` read
 * through `isModalOpen()`. Registering inside the wrapper rather than at each call site is what keeps every consumer
 * covered without anyone having to remember to opt in.
 *
 * `popover.tsx`, `hover-card.tsx`, `select.tsx`, and `tooltip.tsx` are deliberately absent: they do not take over the
 * surface, so suppressing shortcuts behind them would be a behavior change rather than a defect repair. Right-click
 * menus are native OS menus (`lib/context-menu.ts`); AppKit's menu tracking loop already withholds key events from the
 * page while one is open, so they need no registration.
 */
const MODAL_WRAPPERS = ['dialog.tsx', 'menu.tsx'];

describe('shared overlay modal registration', () => {
    it.each(MODAL_WRAPPERS)('registers %s with the shared modal registry', async (fileName) => {
        const source = await readFile(join(uiRoot, fileName), 'utf8');

        expect(source).toContain("from '@/hooks/use-modal-registration'");
        expect(source).toMatch(/useModalRegistration\(/);
    });
});
