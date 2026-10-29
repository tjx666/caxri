import type { AuxiliaryWindowState, PersistedWindowState } from '@caxri/protocol';

import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { SystemAppearance } from './theme';

const DEFAULT_WINDOW_BOUNDS: PersistedWindowState['bounds'] = { width: 1440, height: 900 };
const DEFAULT_AUXILIARY_WINDOW_STATE: AuxiliaryWindowState = {
    caxriBot: { wasOpenAtQuit: false },
    processExplorer: {},
};

/**
 * Persisted main and auxiliary window geometry, restored by Desktop on the next launch.
 */
export function createWindowStateHandlers(
    database: Pick<CaxriDatabase, 'getAppState' | 'setAppState'>,
    appearance: Pick<SystemAppearance, 'set'>,
): Pick<
    DomainHandlers,
    | 'app.auxiliaryWindowState.get'
    | 'app.auxiliaryWindowState.update'
    | 'app.systemAppearance.update'
    | 'app.windowState.get'
    | 'app.windowState.update'
> {
    return {
        'app.systemAppearance.update': ({ scheme }) => {
            appearance.set(scheme);
            return { scheme };
        },
        'app.windowState.get': () => ({
            bounds: database.getAppState('windowBounds') ?? DEFAULT_WINDOW_BOUNDS,
            ...(database.getAppState('windowState') ?? {
                isMaximized: false,
                isFullScreen: false,
            }),
        }),
        'app.windowState.update': (state) => {
            database.setAppState('windowBounds', state.bounds);
            database.setAppState('windowState', {
                isMaximized: state.isMaximized,
                isFullScreen: state.isFullScreen,
            });
            return state;
        },
        'app.auxiliaryWindowState.get': () =>
            database.getAppState('auxiliaryWindowState') ?? DEFAULT_AUXILIARY_WINDOW_STATE,
        'app.auxiliaryWindowState.update': (state) => {
            database.setAppState('auxiliaryWindowState', state);
            return state;
        },
    };
}
