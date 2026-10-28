import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
 * A dev server stand-in: it listens on a free loopback port, prints `port <n>` once, and prints one line per page
 * fetch: `hit proxied` when the request reached it with the proxy's rewritten `localhost` Host, `hit direct` otherwise.
 * The scenario learns how the page arrived without reading anything else the client sent.
 */
const SERVER_SOURCE = String.raw`import { createServer } from 'node:http';
const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${PREVIEW_PAGE_TITLE}</title></head><body style="font-family: sans-serif; padding: 24px"><h1>Synthetic dev server</h1><p>An invented page served from the Session folder.</p></body></html>';
const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
        process.stdout.write(String(request.headers.host).startsWith('localhost:') ? 'hit proxied\n' : 'hit direct\n');
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
    }
    response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write('port ' + server.address().port + '\n'));
`;

interface PreviewServer {
    /**
     * Page fetches that arrived through the preview proxy.
     */
    proxiedHits: () => number;
    /**
     * Page fetches that reached the server any other way, such as straight through the emulator's host loopback.
     */
    directHits: () => number;
    port: number;
    stop: () => Promise<void>;
}

/**
 * Starts the stand-in with `cwd` as its working directory, the ownership signal Server Core matches.
 */
async function startPreviewServer(script: string, cwd: string): Promise<PreviewServer> {
    const child: ChildProcess = spawn(process.execPath, [script], {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    let proxiedHits = 0;
    let directHits = 0;
    let buffered = '';
    const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Preview server exited with ${code}`)));
        child.stdout?.on('data', (chunk: Uint8Array) => {
            buffered += Buffer.from(chunk).toString('utf8');
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            proxiedHits += lines.filter((line) => line === 'hit proxied').length;
            directHits += lines.filter((line) => line === 'hit direct').length;
            const announced = lines.find((line) => line.startsWith('port '));
            if (announced) resolve(Number(announced.slice(5)));
        });
    });
    return {
        directHits: () => directHits,
        port,
        proxiedHits: () => proxiedHits,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) {
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
 * The chip reads `Preview :<port>` (`browser.preview.chipLabel`) while the Session has one server.
 */
const chipText = (port: number): string => `Preview :${port}`;

const isChipShowingOnly = async (serial: string, port: number, other: number): Promise<boolean> =>
    (await mobileNativeControlBounds(serial, { text: chipText(port) })) !== null &&
    (await mobileNativeControlBounds(serial, { text: chipText(other) })) === null;

/**
 * `MOB-CHAT-36`: a web server started from the Session's folder appears as a port chip in the phone's Session header,
 * while one started outside it does not; tapping the chip opens the page through the computer's preview proxy in the
 * in-app browser; the chip stays while the server runs and disappears once it stops.
 */
export async function executeMobileSessionPreviewScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let script = '';
    let outside = '';
    const servers: PreviewServer[] = [];
    const mobile = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
        seedProject: async (projectRoot) => {
            script = join(projectRoot, SERVER_SCRIPT);
            await writeFile(script, SERVER_SOURCE, 'utf8');
            // A sibling of the Project folder, so its server belongs to no Session.
            outside = join(dirname(projectRoot), 'outside-session');
            await mkdir(outside, { recursive: true });
        },
    });
    try {
        if (!mobile.allowedSessionId) throw new Error('Preview fixture is unavailable');
        const inside = await startPreviewServer(script, dirname(script));
        servers.push(inside);
        const stranger = await startPreviewServer(script, outside);
        servers.push(stranger);
        await mobile.pair();
        await tapMobileCheck(serial, `session-row-${mobile.allowedSessionId}`);
        await waitForCheck(serial, 'preview-chip', 60_000);
        if (
            !(await waitForMobile(
                () => isChipShowingOnly(serial, inside.port, stranger.port),
                Boolean,
                20_000,
            ))
        )
            throw new Error('The chip does not show exactly the Session server port');
        await capture(environment, 'chip', artifacts);

        await tapMobileCheck(serial, 'preview-chip');
        await waitForCheck(serial, 'in-app-browser');
        await waitForMobile(
            () => Promise.resolve(inside.proxiedHits()),
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
        // Two polls later the chip must still be there, so its later removal is down to the server stopping.
        await new Promise((resolve) => setTimeout(resolve, 21_000));
        await waitForCheck(serial, 'preview-chip', 1_000);
        await capture(environment, 'chip-kept', artifacts);

        await inside.stop();
        const stoppedAt = Date.now();
        await waitForNoCheck(serial, 'preview-chip', 45_000);
        const removalMs = Date.now() - stoppedAt;
        await waitForCheck(serial, `session-detail-back`, 5_000);
        await capture(environment, 'chip-gone', artifacts);

        if (inside.directHits() + stranger.proxiedHits() + stranger.directHits() > 0)
            throw new Error(
                'A page fetch bypassed the preview proxy or reached the outside server',
            );
        await finish(environment, artifacts, {
            chipPorts: 'session-server-only',
            chipAfterBrowserClose: 'kept-for-two-polls',
            chipRemovalAfterStopMs: removalMs,
            directPageFetches: inside.directHits(),
            outsideServerFetches: stranger.proxiedHits() + stranger.directHits(),
            proxiedPageFetches: inside.proxiedHits(),
            pageTitle: 'in-toolbar',
            status: 'passed',
        });
    } finally {
        await Promise.all(servers.map((server) => server.stop()));
        await mobile.stop();
    }
}
