import { describe, expect, it, vi } from 'vitest';

import {
    buildOsascriptArguments,
    createOsascriptNotificationDriver,
    sanitizeOsascriptText,
} from '../osascript-notification';

describe('osascript notification', () => {
    it('keeps notification text out of the script and passes it as argv items', () => {
        const hostile = 'x" & (do shell script "id") & "\\';
        const arguments_ = buildOsascriptArguments({
            body: hostile,
            subtitle: 'Project',
            title: '-e evil',
        });

        const separator = arguments_.indexOf('--');
        const scriptLines = arguments_.slice(0, separator).filter((value) => value !== '-e');
        expect(scriptLines.join('\n')).not.toContain('do shell script');
        expect(arguments_.slice(separator + 1)).toEqual(['-e evil', hostile, 'Project']);
    });

    it('passes an empty subtitle so the script always sees three items', () => {
        const arguments_ = buildOsascriptArguments({ body: 'Body', title: 'Title' });

        expect(arguments_.slice(arguments_.indexOf('--') + 1)).toEqual(['Title', 'Body', '']);
    });

    it('flattens control characters and bounds the length', () => {
        expect(sanitizeOsascriptText('line one\nline\u{0}two\r\n')).toBe('line one line two ');
        expect(sanitizeOsascriptText('a'.repeat(5_000))).toHaveLength(1_000);
    });

    it('runs the system osascript with structured argv and reports its outcome', async () => {
        const run = vi.fn(() => Promise.resolve(true));
        const driver = createOsascriptNotificationDriver({ run });

        await expect(
            driver.show({ body: 'Body', groupId: 'g', id: 'i', title: 'Title' }),
        ).resolves.toBe(true);

        expect(run).toHaveBeenCalledWith(
            '/usr/bin/osascript',
            buildOsascriptArguments({ body: 'Body', title: 'Title' }),
        );
    });
});
