import { StructuredLogger } from '@caxri/system';

import { resolveDesktopLogLevel } from './log-level';

export function createDesktopLogger(logDirectory: string, isPackaged: boolean): StructuredLogger {
    return new StructuredLogger(logDirectory, 'desktop', resolveDesktopLogLevel({ isPackaged }));
}
