import type { CommandId } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { CommandDefinition } from './registry';
import { defineCommand, getRegisteredCommand, registerCommand } from './registry';

function definition(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
    return {
        id: 'test.command' as CommandId,
        title: 'Test command',
        category: 'Test',
        run: () => {},
        ...overrides,
    };
}

describe('defineCommand', () => {
    it('returns the given definition unchanged, as a type-checking identity helper', () => {
        const input = definition();

        expect(defineCommand(input)).toBe(input);
    });
});

describe('registerCommand / getRegisteredCommand', () => {
    it('registers a command and retrieves it by id', () => {
        const command = definition({ id: 'test.register' as CommandId });

        registerCommand(command);

        expect(getRegisteredCommand('test.register')).toBe(command);
    });

    it('returns undefined for an id that was never registered', () => {
        expect(getRegisteredCommand('test.never-registered')).toBeUndefined();
    });

    it('overwrites a previous registration for the same id', () => {
        const first = definition({ id: 'test.overwrite' as CommandId, title: 'First' });
        const second = definition({ id: 'test.overwrite' as CommandId, title: 'Second' });

        registerCommand(first);
        registerCommand(second);

        expect(getRegisteredCommand('test.overwrite')).toBe(second);
        expect(getRegisteredCommand('test.overwrite')?.title).toBe('Second');
    });
});
