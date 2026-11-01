import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

/**
 * Every `MOB-CHAT-*` Android case once failed before it started, with `does not provide an export named
 * 'isAndroidCheckId'`: the scenario spec's static imports reached `apps/mobile` (CommonJS) modules, which loaded a
 * shared `scripts/` module as CommonJS, and the Chat case registry's later dynamic ESM import of the same module then
 * failed. Only Playwright's loader produces that order, and those cases run only on an emulator, so this runs the
 * device-free probe under Playwright.
 */
describe('mobile Chat case loading under Playwright', () => {
    it('collects the Chat case handlers after the Android scenario spec imports', () => {
        const result = spawnSync(
            'bunx',
            [
                'playwright',
                'test',
                '--config',
                join(import.meta.dirname, 'mobile-chat-case-loader.playwright.config.ts'),
            ],
            {
                encoding: 'utf8',
                // Resolve workspace packages to their sources (the `bun` export condition), so no `dist` build is needed.
                env: { ...process.env, NODE_OPTIONS: '--conditions=bun' },
                timeout: 120_000,
            },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 150_000);
});
