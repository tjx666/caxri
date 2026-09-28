import { describe, expect, it } from 'vitest';

import { shellCommandToast } from './shell-command-commands';

const linkPath = '/usr/local/bin/caxri';

describe('shellCommandToast', () => {
    it.each([
        ['installed', 'success'],
        ['alreadyInstalled', 'info'],
        ['uninstalled', 'success'],
        ['notInstalled', 'info'],
    ] as const)('confirms %s with a %s toast naming the link', (status, kind) => {
        const toast = shellCommandToast({ status, linkPath });
        expect(toast?.kind).toBe(kind);
        expect(toast?.message).toContain(linkPath);
    });

    it('stays silent when the user canceled the prompt', () => {
        expect(shellCommandToast({ status: 'canceled', linkPath })).toBeUndefined();
    });
});
