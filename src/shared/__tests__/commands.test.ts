import { describe, expect, it } from 'vitest';

import { defaultKeybindings } from '../../runtime/configuration';
import { commandDefinitions } from '../commands';

describe('command registry', () => {
    it('has unique IDs and owns every default keybinding command', () => {
        const ids = commandDefinitions.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(defaultKeybindings.every((binding) => ids.includes(binding.command))).toBe(true);
    });
});
