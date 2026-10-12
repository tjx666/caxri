import { describe, expect, it } from 'vitest';

import { chatPermissionToStore } from '../chat-permission-switch';

describe('Stored Chat permission', () => {
    it('keeps an inherited level unstored until the user picks one', () => {
        const next = { permissionMode: 'fullAccess' as const, planMode: true };
        // Only plan mode changed on a Chat that follows the launch settings.
        expect(chatPermissionToStore(undefined, next)).toEqual({ planMode: true });
        expect(chatPermissionToStore({ planMode: false }, next)).toEqual({ planMode: true });
        // The user picked the level now, or picked one before.
        expect(chatPermissionToStore(undefined, next, true)).toEqual(next);
        expect(chatPermissionToStore({ permissionMode: 'ask', planMode: false }, next)).toEqual(
            next,
        );
    });
});
