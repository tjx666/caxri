import process from 'node:process';

import type { Keybinding } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * E2E fault injection for the native menu's keybinding read. Acceptance needs a deterministic one-shot read failure
 * after the new value is durable. Matching the configured fixture key avoids startup-attempt counting, which varies
 * when Server is already ready. Outside E2E every read passes through unchanged.
 */
export function createMenuKeybindingFailureInjection(): (
    keybindings: Keybinding[],
) => Keybinding[] {
    let isInjected = false;
    return (keybindings) => {
        const failureKey =
            process.env.CAXRI_E2E === '1'
                ? process.env.CAXRI_E2E_FAIL_MENU_KEYBINDINGS_GET_COPY_KEY
                : undefined;
        if (
            isInjected ||
            !failureKey ||
            keybindings.every(
                (binding) => !(binding.command === 'terminal.copy' && binding.key === failureKey),
            )
        )
            return keybindings;
        isInjected = true;
        process.env.CAXRI_E2E_MENU_KEYBINDINGS_GET_FAILURE_INJECTED = '1';
        throw new CaxriError('UNAVAILABLE', 'Injected E2E menu keybinding read failure');
    };
}
