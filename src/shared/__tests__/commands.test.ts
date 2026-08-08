import { describe, expect, it } from 'vitest';

import { commandDefinitions, defaultKeybindings } from '../commands';

describe('command registry', () => {
    it('has unique IDs and owns every default keybinding command', () => {
        const ids = commandDefinitions.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(commandDefinitions.every((command) => command.description.trim().length > 0)).toBe(
            true,
        );
        expect(defaultKeybindings.every((binding) => ids.includes(binding.command))).toBe(true);
        expect(defaultKeybindings).toEqual(
            expect.arrayContaining([
                { key: 'cmd+k', command: 'terminal.clear' },
                { key: 'cmd+[', command: 'sidebar.toggle' },
                { key: 'cmd+]', command: 'inspector.toggle' },
                { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
                { key: 'cmd+,', command: 'settings.open' },
                { key: 'cmd+shift+p', command: 'commandPalette.open' },
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+w', command: 'workbench.closeActiveTab' },
            ]),
        );
    });
});
