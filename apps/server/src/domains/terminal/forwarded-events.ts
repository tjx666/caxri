import type { ServerEvent } from '@caxri/protocol';

import type { TerminalExecutionEvent } from './execution-port';

/**
 * The Client event a Host execution event is forwarded as, unchanged. Events that change Core state (activity, titles,
 * managed Agent start and exit) return `undefined`; `TerminalManager` projects those itself.
 */
export function forwardedServerEvent(event: TerminalExecutionEvent): ServerEvent | undefined {
    switch (event.type) {
        case 'output': {
            return {
                event: 'terminal.output',
                payload: {
                    terminalId: event.terminalId,
                    data: event.data,
                    ...(event.droppedBytes !== undefined && { droppedBytes: event.droppedBytes }),
                },
            };
        }
        case 'outputRecovery': {
            return {
                event: 'terminal.outputRecovery',
                payload: {
                    terminalId: event.terminalId,
                    provider: event.provider,
                    status: event.status,
                },
            };
        }
        case 'sizeOwnership': {
            return {
                event: 'terminal.sizeOwnership',
                payload: {
                    terminalId: event.terminalId,
                    owner: event.owner,
                    cols: event.cols,
                    rows: event.rows,
                },
            };
        }
        default: {
            return undefined;
        }
    }
}
