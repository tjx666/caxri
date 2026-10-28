import type { App } from 'electron';

const requests: { pending: string[]; consumer?: (path: string) => void } = { pending: [] };

/**
 * Starts holding macOS "open document" requests (`open-file`) until {@link consumeOpenFileRequests} takes them.
 *
 * Installed from `bootstrap.ts`, before the Main graph loads: on a cold launch macOS delivers the document right after
 * `will-finish-launching`, and a request with no listener is lost. `preventDefault` tells Electron the request was
 * handled, so macOS does not report that Caxri could not open it.
 */
export function holdOpenFileRequests(app: Pick<App, 'on'>): void {
    app.on('open-file', (event, path) => {
        event.preventDefault();
        if (requests.consumer) requests.consumer(path);
        else requests.pending.push(path);
    });
}

/**
 * Hands every held request, then each later one, to `next`. Called once the Workbench can receive them.
 */
export function consumeOpenFileRequests(next: (path: string) => void): void {
    requests.consumer = next;
    const held = requests.pending;
    requests.pending = [];
    for (const path of held) next(path);
}
