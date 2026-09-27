import type { ServerRequest } from '@caxri/protocol';

import type { MobileTerminalObserver } from './gateway/terminal-observer';

type TerminalControlRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.terminal.takeOver'
            | 'mobile.terminal.release'
            | 'mobile.terminal.input'
            | 'mobile.terminal.scroll';
    }
>;

/**
 * Applies one authorized Terminal control request to the caller's own subscription observer.
 */
export async function invokeMobileTerminalRequest(
    request: TerminalControlRequest,
    observer: MobileTerminalObserver,
): Promise<{ expiresAt: number } | null> {
    const { expectedGeneration } = request.params;
    switch (request.method) {
        case 'mobile.terminal.takeOver': {
            return observer.takeOver(expectedGeneration, {
                cols: request.params.cols,
                rows: request.params.rows,
            });
        }
        case 'mobile.terminal.release': {
            await observer.releaseTakeOver(expectedGeneration);
            return null;
        }
        case 'mobile.terminal.scroll': {
            const { col, lines, row } = request.params;
            await observer.scroll(expectedGeneration, { col, lines, row });
            return null;
        }
        case 'mobile.terminal.input': {
            await observer.input(expectedGeneration, request.params.data);
            return null;
        }
    }
}
