import { describe, expect, it } from 'vitest';

import { agentChatAddSheetRows } from '../agent-chat-add-sheet';

const model = {
    model: 'Opus 4.1',
    effort: 'High',
    isUltracode: false,
    isInteractive: true,
    accessibilityLabel: 'Model Opus 4.1',
};
const permission = {
    label: 'Ask',
    isFullAccess: false,
    isPlanMode: false,
    isInteractive: true,
    accessibilityLabel: 'Permissions Ask',
};
const context = { used: 0.42, percent: 42, isWarning: false, accessibilityLabel: '42%' };

describe('agentChatAddSheetRows', () => {
    it('names each setting with its current value, in model, permission, usage order', () => {
        expect(agentChatAddSheetRows({ context, hasUsage: true, model, permission })).toEqual([
            { entry: 'model', label: 'Model', value: 'Opus 4.1 · High', isEnabled: true },
            { entry: 'permission', label: 'Permissions', value: 'Ask', isEnabled: true },
            { entry: 'usage', label: 'Session usage', value: '42%', isEnabled: true },
        ]);
    });

    it('adds the mode words the chips trail with', () => {
        const rows = agentChatAddSheetRows({
            context: undefined,
            hasUsage: false,
            model: { ...model, isUltracode: true },
            permission: { ...permission, isPlanMode: true },
        });
        expect(rows.map(({ value }) => value)).toEqual([
            'Opus 4.1 · High · Ultracode',
            'Ask · Plan',
        ]);
    });

    it('keeps a read-only setting visible but disabled, and leaves out what the Chat has not reported', () => {
        expect(
            agentChatAddSheetRows({
                context: undefined,
                hasUsage: true,
                model: { ...model, isInteractive: false },
                permission: undefined,
            }),
        ).toEqual([
            { entry: 'model', label: 'Model', value: 'Opus 4.1 · High', isEnabled: false },
            { entry: 'usage', label: 'Session usage', value: undefined, isEnabled: true },
        ]);
    });
});
