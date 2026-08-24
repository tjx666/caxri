import type { ElectronApplication } from '@playwright/test';
import type * as Electron from 'electron';

type ClipboardSafeElectron = Omit<typeof Electron, 'clipboard'>;

/**
 * Exposes only the Electron application operations used by E2E specs. Main-process evaluation deliberately omits the
 * native clipboard; specs must request the protected clipboard capability so pool isolation is tied to a typed launch
 * contract rather than identifier-name heuristics.
 */
export type E2EApp = Pick<
    ElectronApplication,
    'close' | 'firstWindow' | 'process' | 'waitForEvent' | 'windows'
> & {
    evaluate: {
        <R, Argument>(
            pageFunction: (electron: ClipboardSafeElectron, argument: Argument) => Promise<R> | R,
            argument: Argument,
        ): Promise<R>;
        <R>(pageFunction: (electron: ClipboardSafeElectron) => Promise<R> | R): Promise<R>;
    };
};
