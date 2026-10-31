import { useCallback, useRef, useState } from 'react';

import type { ArgvConfig, ArgvConfigChanges } from '@caxri/protocol';

import { dismissToastsMatching, pushToast } from '../../../stores/toasts';
import {
    argvRestartNotice,
    isArgvRestartNotice,
    rememberArgvRestartNotice,
} from '../argv-restart-notice';
import { writeArgvConfig } from '../settings-client';
import { reportSettingsError } from '../settings-error-report';

/**
 * The Main-owned boot config (`argv.jsonc`) shown on the Settings page. It is written directly through its desktop
 * method, not the settings.jsonc draft and debounce pipeline.
 */
export function useArgvConfig() {
    const [argvConfig, setArgvConfig] = useState<ArgvConfig>();
    const argvWriteGeneration = useRef(0);
    // Boot-session baseline for the restart hint: what the running instance actually launched
    // with, as of Settings load. Diverging from it needs a restart; returning to it does not.
    const argvConfigAtLoad = useRef<ArgvConfig | undefined>(undefined);

    const applyLoadedArgvConfig = useCallback((value: ArgvConfig): void => {
        setArgvConfig(value);
        // Spelled out rather than `??=`, which React Compiler cannot lower yet.
        const baseline = argvConfigAtLoad.current;
        argvConfigAtLoad.current = baseline ?? value;
    }, []);

    const updateArgvConfig = (changes: ArgvConfigChanges): void => {
        // Optimistic update, "tell the user, do not revert" on failure, matching the settings write
        // path; the generation counter drops out-of-order responses from rapid toggles, mirroring
        // `writeGeneration`.
        setArgvConfig((current) => (current ? { ...current, ...changes } : current));
        const generation = ++argvWriteGeneration.current;
        void (async (): Promise<void> => {
            try {
                const result = await writeArgvConfig({ changes });
                if (argvWriteGeneration.current !== generation) return;
                setArgvConfig(result.value);
                const notice = argvRestartNotice({
                    applied: result.value,
                    baseline: argvConfigAtLoad.current,
                });
                // The card is a status, not an event: retract the previous wording first so a write that changes which
                // flags are pending (including one that returns the last of them to its launch value) can never leave
                // a stale instruction on screen.
                dismissToastsMatching(isArgvRestartNotice);
                // Held until dismissed: the user is still looking at the Settings row they just flipped, so a
                // four-second expiry would take away the only record of the restart they now owe before they can act
                // on it.
                if (notice) {
                    rememberArgvRestartNotice(notice);
                    pushToast('info', notice, { persist: true });
                }
            } catch (error) {
                reportSettingsError(error, 'argv.jsonc');
            }
        })();
    };

    return { applyLoadedArgvConfig, argvConfig, updateArgvConfig };
}
