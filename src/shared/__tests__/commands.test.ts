import { describe, expect, it } from 'vitest';

import { commandDefinitions, defaultKeybindings } from '../commands';

describe('command registry', () => {
    it('has unique IDs and owns every default keybinding command', () => {
        const ids = commandDefinitions.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(defaultKeybindings.every((binding) => ids.includes(binding.command))).toBe(true);
        expect(defaultKeybindings).toEqual(
            expect.arrayContaining([
                { key: 'cmd+k', command: 'terminal.clear' },
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+w', command: 'terminal.close' },
            ]),
        );
    });
});
