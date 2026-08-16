import { describe, expect, it } from 'vitest';

import { commandIdSchema, inspectorCommandId } from '../commands.js';
import type { InspectorCommandId } from '../inspector.js';

describe('inspectorCommandId', () => {
    it('threads an Inspector mode command id through as itself', () => {
        const id: InspectorCommandId = 'inspector.showGit';
        expect(inspectorCommandId(id)).toBe('inspector.showGit');
    });
});

describe('commandIdSchema', () => {
    it('accepts a known catalog command', () => {
        expect(commandIdSchema.safeParse('terminal.restart').success).toBe(true);
    });

    it('accepts every Inspector mode command registered via inspectorCommandId', () => {
        const inspectorIds: InspectorCommandId[] = [
            'inspector.showFiles',
            'inspector.showGit',
            'inspector.showStatus',
            'inspector.showInfo',
        ];
        for (const id of inspectorIds) {
            expect(commandIdSchema.safeParse(inspectorCommandId(id)).success).toBe(true);
        }
    });

    it('rejects an unregistered command id', () => {
        expect(commandIdSchema.safeParse('workbench.doesNotExist').success).toBe(false);
    });
});
