import { describe, expect, it } from 'vitest';

import type { BottomPanelCommandId } from '../bottom-panel.js';
import { bottomPanelViewRegistrations } from '../bottom-panel.js';
import { bottomPanelCommandId, commandIdSchema, inspectorCommandId } from '../commands.js';
import type { InspectorCommandId } from '../inspector.js';
import { inspectorModeRegistrations } from '../inspector.js';

describe('inspectorCommandId', () => {
    it('threads an Inspector mode command id through as itself', () => {
        const id: InspectorCommandId = 'inspector.showGit';
        expect(inspectorCommandId(id)).toBe('inspector.showGit');
    });
});

describe('bottomPanelCommandId', () => {
    it('threads a Bottom Panel view command id through as itself', () => {
        const id: BottomPanelCommandId = 'bottomPanel.showLogs';
        expect(bottomPanelCommandId(id)).toBe('bottomPanel.showLogs');
    });
});

describe('commandIdSchema', () => {
    it('accepts a known catalog command', () => {
        expect(commandIdSchema.safeParse('terminal.restart').success).toBe(true);
    });

    it('accepts every Inspector mode command registered via inspectorCommandId', () => {
        for (const { commandId } of inspectorModeRegistrations) {
            expect(commandIdSchema.safeParse(inspectorCommandId(commandId)).success).toBe(true);
        }
    });

    it('accepts every Bottom Panel view command registered via bottomPanelCommandId', () => {
        for (const { commandId } of bottomPanelViewRegistrations) {
            expect(commandIdSchema.safeParse(bottomPanelCommandId(commandId)).success).toBe(true);
        }
    });

    /**
     * Info and Logs moved from the Inspector to the Bottom Panel; their old ids must not linger in the catalog, or a
     * stale keybinding or menu entry would resolve to a command with no registry handler.
     */
    it('rejects the retired Inspector ids for the views that moved to the Bottom Panel', () => {
        expect(commandIdSchema.safeParse('inspector.showInfo').success).toBe(false);
        expect(commandIdSchema.safeParse('inspector.showLogs').success).toBe(false);
    });

    it('rejects an unregistered command id', () => {
        expect(commandIdSchema.safeParse('workbench.doesNotExist').success).toBe(false);
    });
});
