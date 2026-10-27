import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileNativeControlBounds,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * The page's `<title>`, which only the in-app browser's toolbar pill shows: the heading differs, so a text match finds
 * the pill alone.
 */
const PREVIEW_PAGE_TITLE = 'Caxri preview page';

const SERVER_SCRIPT = 'preview-server.mjs';

/**
 * A dev server stand-in: it listens on a free loopback port, prints `port <n>` once, and prints `hit` for every page
 * fetch, so the scenario can count fetches without reading what the client sent.
 */
const SERVER_SOURCE = String.raw`import { createServer } from 'node:http';
const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${PREVIEW_PAGE_TITLE}</title></head><body style="font-family: sans-serif; padding: 24px"><h1>Synthetic dev server</h1><p>An invented page served from the Session folder.</p></body></html>';
const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
        process.stdout.write('hit\n');
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
    }
    response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write('port ' + server.address().port + '\n'));
`;

interface PreviewServer {
    hits: () => number;
    port: number;
    stop: () => Promise<void>;
}

/**
 * Starts the stand-in with the Session's folder as its working directory, the ownership signal Server Core matches.
 */
async function startPreviewServer(root: string): Promise<PreviewServer> {
    const child: ChildProcess = spawn(process.execPath, [SERVER_SCRIPT], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    let hits = 0;
    let buffered = '';
    const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Preview server exited with ${code}`)));
        child.stdout?.on('data', (chunk: Uint8Array) => {
            buffered += Buffer.from(chunk).toString('utf8');
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            hits += lines.filter((line) => line === 'hit').length;
            const announced = lines.find((line) => line.startsWith('port '));
            if (announced) resolve(Number(announced.slice(5)));
        });
    });
    return {
        hits: () => hits,
        port,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null) {
                    resolve();
                    return;
                }
                child.removeAllListeners('exit');
                child.once('exit', () => resolve());
                child.kill('SIGTERM');
            }),
    };
}

/**
 * `MOB-CHAT-35`: a web server started from the Session's folder appears as a port chip in the phone's Session header;
 * tapping it opens the page through the computer in the in-app browser, and the chip disappears once the server stops.
 */
export async function executeMobileSessionPreviewScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let root = '';
    let server: PreviewServer | undefined;
    const mobile = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
        seedProject: async (projectRoot) => {
            root = projectRoot;
            await writeFile(join(projectRoot, SERVER_SCRIPT), SERVER_SOURCE, 'utf8');
        },
    });
    try {
        if (!mobile.allowedSessionId) throw new Error('Preview fixture is unavailable');
        server = await startPreviewServer(root);
        await mobile.pair();
        await tapMobileCheck(serial, `session-row-${mobile.allowedSessionId}`);
        await waitForCheck(serial, 'preview-chip', 60_000);
        await capture(environment, 'chip', artifacts);

        await tapMobileCheck(serial, 'preview-chip');
        await waitForCheck(serial, 'in-app-browser');
        const preview = server;
        await waitForMobile(
            () => Promise.resolve(preview.hits()),
            (hits) => hits >= 1,
        );
        const pillTitle = await waitForMobile(
            () =>
                mobileNativeControlBounds(serial, {
                    className: 'android.widget.TextView',
                    text: PREVIEW_PAGE_TITLE,
                }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (!pillTitle) throw new Error('The previewed page did not report its title');
        await capture(environment, 'page', artifacts);

        await tapMobileCheckByBounds(serial, 'in-app-browser-close');
        await waitForNoCheck(serial, 'in-app-browser');
        await server.stop();
        // The chip refreshes every 10 seconds while the Session is on screen.
        await waitForNoCheck(serial, 'preview-chip', 45_000);
        await capture(environment, 'chip-gone', artifacts);

        await finish(environment, artifacts, {
            chip: 'shown-then-removed',
            page: 'loaded-through-proxy',
            pageFetches: preview.hits(),
            pageTitle: 'in-toolbar',
            status: 'passed',
        });
    } finally {
        await server?.stop();
        await mobile.stop();
    }
}
