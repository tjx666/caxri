import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The address an Android emulator reaches the Mac's loopback interface through.
 */
const EMULATOR_HOST_LOOPBACK = '10.0.2.2';

const MOBILE_BROWSER_PAGE_PATH = '/caxri-acceptance-page';
/**
 * The page's `<title>`, which only the toolbar's pill shows: the heading differs, so a text match finds the pill alone.
 */
export const MOBILE_BROWSER_PAGE_TITLE = 'Caxri Acceptance page';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${MOBILE_BROWSER_PAGE_TITLE}</title>
</head>
<body style="font-family: sans-serif; padding: 24px">
<h1>Synthetic page heading</h1>
<p>An invented page the in-app browser case opens from a Chat reply.</p>
</body>
</html>
`;

export interface MobileBrowserPage {
    /**
     * The page as the emulator addresses it.
     */
    url: string;
    /**
     * The page as this Mac addresses it, for the fixture's own checks.
     */
    localUrl: string;
    /**
     * How many times a client has fetched the page; a reload adds one.
     */
    hits: () => number;
    close: () => Promise<void>;
}

/**
 * Serves one synthetic HTML page on the Mac's loopback interface only, so the in-app browser case never leaves the
 * machine. Every other path answers 404, and nothing the client sends is recorded beyond the fetch count.
 */
export async function startMobileBrowserPage(): Promise<MobileBrowserPage> {
    let hits = 0;
    const server = createServer((request, response) => {
        // A query string names nothing the page reads; the inline link case adds one only to make its URL long.
        if (
            request.method === 'GET' &&
            request.url?.split('?', 1)[0] === MOBILE_BROWSER_PAGE_PATH
        ) {
            hits += 1;
            response.writeHead(200, {
                'cache-control': 'no-store',
                'content-type': 'text/html; charset=utf-8',
            });
            response.end(PAGE);
            return;
        }
        response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://${EMULATOR_HOST_LOOPBACK}:${port}${MOBILE_BROWSER_PAGE_PATH}`,
        localUrl: `http://127.0.0.1:${port}${MOBILE_BROWSER_PAGE_PATH}`,
        hits: () => hits,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
