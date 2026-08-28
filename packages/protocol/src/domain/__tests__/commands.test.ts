import { describe, expect, it } from 'vitest';

import { commandIdSchema } from '../commands.js';

describe('commandIdSchema', () => {
    it.each([
        'secondarySidebar.showFiles',
        'secondarySidebar.showGit',
        'secondarySidebar.showStatus',
        'secondarySidebar.toggle',
        'panel.showLogs',
        'panel.showInfo',
        'panel.toggle',
        'primarySidebar.toggle',
    ])('accepts builtin chrome command %s', (command) => {
        expect(commandIdSchema.safeParse(command).success).toBe(true);
    });

    it('keeps dynamic extension commands out of the builtin enum', () => {
        expect(commandIdSchema.safeParse('publisher.extension.refresh').success).toBe(false);
    });
});
