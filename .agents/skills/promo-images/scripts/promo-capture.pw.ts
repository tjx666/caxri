/**
 * Captures one promo scene: seeds its Projects, launches an isolated Caxri with scripted fake Agents, plays every
 * Session's prompt, pairs the Android app, then writes `desktop.png`, `mobile.png` and `receipt.json` to
 * `CAXRI_PROMO_CAPTURE_DIR`. `promo.ts` prepares the emulator and runs it; run that instead of this spec.
 *
 * It runs under the E2E fixture so the shared launcher, desktop lease and error gate apply: an error toast or error log
 * fails the capture rather than ending up in the image.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentChatSnapshot, BootstrapState } from '@caxri/protocol';
import { builtinThemes } from '@caxri/protocol';

import {
    fakeClaudeChatExecutableSource,
    fakeCodexChatExecutableSource,
} from '../../../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { createFakeAgentMode } from '../../../../e2e/support/agent-fixture.ts';
import { test } from '../../../../e2e/support/fixtures.ts';
import type { RunningCaxri } from '../../../../e2e/support/helpers.ts';
import { launchCaxri, pageRequest } from '../../../../e2e/support/helpers.ts';
import {
    captureMobileFramebuffer,
    mobileSemantics,
    openMobilePairingLink,
    waitForMobile,
} from '../../../../e2e/support/mobile-android.ts';
import { showDemoStatusBar } from './promo-android';
import type { PromoScene, PromoSceneSession } from './promo-scene';
import { DESKTOP_CAPTURE_SCALE, loadPromoScene } from './promo-scene';
import { seedPromoProject, writePromoSettings } from './promo-seed';

/**
 * Time for the last state change to reach every surface (Chat stream end, sidebar status, phone list) before capture.
 */
const SETTLE_MS = 2500;

function requireEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required; run the capture through promo.ts`);
    return value;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(
    label: string,
    read: () => Promise<T>,
    isAccepted: (value: T) => boolean,
    timeoutMs = 60_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each read depends on the previous state
        const value = await read();
        if (isAccepted(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop -- bounded polling
        await delay(250);
    }
}

interface CreatedSession {
    scene: PromoSceneSession;
    sessionId: string;
    terminalId: string;
}

/**
 * Creates and names one Chat Session without starting its Agent.
 */
async function createSession(
    running: RunningCaxri,
    projectIds: Map<string, string>,
    session: PromoSceneSession,
): Promise<CreatedSession> {
    const { page } = running;
    const created = await pageRequest<{ session: { id: string }; terminal: { id: string } | null }>(
        page,
        'session.create',
        {
            projectId: projectIds.get(session.project),
            defaultAgent: session.agent,
            surface: 'chat',
        },
    );
    if (!created.terminal) throw new Error(`Session ${session.key} opened no Chat`);
    const sessionId = created.session.id;
    await pageRequest(page, 'session.rename', { sessionId, displayTitle: session.title });
    return { scene: session, sessionId, terminalId: created.terminal.id };
}

/**
 * Sends a Session's prompt and waits for the activity state the scene expects.
 */
async function playSession(running: RunningCaxri, session: CreatedSession): Promise<void> {
    const { page } = running;
    await pageRequest(page, 'agentChat.send', {
        terminalId: session.terminalId,
        text: session.scene.prompt,
    });
    await poll(
        `${session.scene.key} to be ${session.scene.expect}`,
        () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
        (state) =>
            state.sessions.find(({ id }) => id === session.sessionId)?.lastActivityState ===
            session.scene.expect,
    );
}

async function acknowledge(running: RunningCaxri, sessions: CreatedSession[]): Promise<void> {
    const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
    for (const { scene, sessionId } of sessions) {
        const current = state.sessions.find(({ id }) => id === sessionId);
        if (!scene.read || !current?.hasUnread) continue;
        // eslint-disable-next-line no-await-in-loop -- few Sessions, each acknowledged once
        await pageRequest(running.page, 'session.markRead', {
            sessionId,
            attentionEpoch: current.attentionEpoch,
        });
    }
}

/**
 * Hides development-only chrome a published image must not show: the status bar's remote-debugging chip, present
 * because the capture drives the window over CDP.
 */
async function hideDevelopmentChrome(running: RunningCaxri): Promise<void> {
    await running.page.addStyleTag({
        content: '.statusbar :is(span, button):has(> svg.lucide-bug) { display: none !important; }',
    });
}

/**
 * Folds the cross-Session waiting popup into the status bar's "N waiting for you" item, as a user would: open, it sits
 * over the captured Session and its Secondary Side Bar. The pointer then leaves the window so no hover state shows.
 */
async function foldWaitingPopup(running: RunningCaxri, isWaiting: boolean): Promise<void> {
    const { page } = running;
    if (isWaiting) {
        const minimize = page.locator('[data-agent-chat-waiting="card"]').getByRole('button', {
            name: 'Minimize',
        });
        await minimize.click();
        await minimize.waitFor({ state: 'detached' });
    }
    await page.mouse.move(0, 0);
}

/**
 * Sizes the window and its Renderer for the capture: the content size the scene names, at device scale 2.
 */
async function sizeDesktop(running: RunningCaxri, scene: PromoScene): Promise<void> {
    const { width, height } = scene.desktop;
    await running.app.evaluate(
        ({ BrowserWindow }, size) => {
            for (const window of BrowserWindow.getAllWindows())
                window.setContentSize(size.width, size.height);
        },
        { width, height },
    );
    const cdp = await running.page.context().newCDPSession(running.page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: DESKTOP_CAPTURE_SCALE,
        mobile: false,
    });
}

async function pairPhone(
    running: RunningCaxri,
    serial: string,
    projectIds: string[],
    sessions: CreatedSession[],
): Promise<void> {
    await pageRequest(running.page, 'mobile.access.enable');
    // The pairing link carries this machine's addresses and a secret: it goes straight to the device, never to a log.
    const pairing = await pageRequest<{ pairingLink: string }>(
        running.page,
        'mobile.pairing.create',
        {
            projectIds,
        },
    );
    await openMobilePairingLink(serial, pairing.pairingLink);
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            sessions.every(({ sessionId }) =>
                nodes.some(({ checkId }) => checkId === `session-row-${sessionId}`),
            ),
        90_000,
    );
}

test('capture a promo scene', async () => {
    const { scene, scripts, holds } = await loadPromoScene(requireEnvironment('CAXRI_PROMO_SCENE'));
    const captureDirectory = requireEnvironment('CAXRI_PROMO_CAPTURE_DIR');
    const serial = requireEnvironment('CAXRI_PROMO_ANDROID_SERIAL');
    await mkdir(captureDirectory, { recursive: true });

    // A neutral root outside HOME: Project paths can surface in the UI, and HOME carries the user's account name.
    const directory = await realpath(await mkdtemp('/tmp/caxri-promo-'));
    const userData = join(directory, 'profile');
    const control = join(directory, 'control');
    let running: RunningCaxri | undefined;
    try {
        await mkdir(control, { recursive: true });
        await Promise.all(holds.map((file) => writeFile(join(control, file), '')));
        const roots = await Promise.all(
            scene.projects.map((project, index) =>
                seedPromoProject(join(directory, 'projects'), project, index),
            ),
        );
        await writePromoSettings(userData);
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                ...(scripts.claude && {
                    claude: {
                        executableSource: fakeClaudeChatExecutableSource({
                            controlDirectory: control,
                            scriptPath: scripts.claude,
                        }),
                    },
                }),
                ...(scripts.codex && {
                    codex: {
                        executableSource: fakeCodexChatExecutableSource({
                            stateDirectory: join(directory, 'codex-threads'),
                            nativeUsageHome: join(userData, 'e2e-agents', 'codex'),
                            scriptPath: scripts.codex,
                            controlDirectory: control,
                        }),
                    },
                }),
            },
        });
        running = await launchCaxri({
            userDataDir: userData,
            testRootPath: roots[0],
            agentMode,
            env: {
                CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots),
                CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: scene.mobile.hostName,
            },
        });
        const { page } = running;
        const theme = builtinThemes.find(({ id }) => id === scene.theme);
        await pageRequest(page, 'theme.update', { source: JSON.stringify(theme) });
        await sizeDesktop(running, scene);

        const projectIds = new Map<string, string>();
        for (const [index, project] of scene.projects.entries()) {
            // Test folder grants are consumed in the order CAXRI_TEST_ROOT_PATHS lists them.
            // eslint-disable-next-line no-await-in-loop -- each one-shot grant precedes its Project
            const root = await pageRequest<string | null>(page, 'dialog.selectDirectory');
            if (root !== roots[index])
                throw new Error(`Unexpected root for Project ${project.key}`);
            // eslint-disable-next-line no-await-in-loop -- the Project id owns its Sessions
            const created = await pageRequest<{ id: string }>(page, 'project.create', {
                rootPath: root,
            });
            projectIds.set(project.key, created.id);
        }

        const sessions: CreatedSession[] = [];
        for (const session of scene.sessions) {
            // eslint-disable-next-line no-await-in-loop -- Sessions are created in scene order
            sessions.push(await createSession(running, projectIds, session));
        }
        const shown = sessions.find(({ scene: { key } }) => key === scene.desktop.session);
        if (!shown) throw new Error('The desktop Session was not created');
        // Every other Session plays off-screen: the Renderer marks the selected Session read as soon as it shows new
        // attention, so a Session that played while selected would lose its unread glyph.
        await pageRequest(page, 'session.select', { sessionId: shown.sessionId });

        /**
         * Held turns never settle, so the phone pairs while every other Session is idle and its list can be read.
         */
        const settled = sessions.filter(({ scene: { expect } }) => expect !== 'running');
        const held = sessions.filter(({ scene: { expect } }) => expect === 'running');
        for (const session of settled) {
            // eslint-disable-next-line no-await-in-loop -- Sessions play in scene order
            await playSession(running, session);
        }
        await acknowledge(running, sessions);
        await pairPhone(running, serial, projectIds.values().toArray(), sessions);
        for (const session of held) {
            // eslint-disable-next-line no-await-in-loop -- Sessions play in scene order
            await playSession(running, session);
        }

        if (scene.desktop.panel) {
            await page
                .getByRole('tablist', { name: 'Secondary Side Bar' })
                .getByRole('tab', { name: scene.desktop.panel, exact: true })
                .click();
        }
        await foldWaitingPopup(
            running,
            sessions.some((session) => session !== shown && session.scene.expect === 'waiting'),
        );
        await poll(
            'the desktop Chat to finish streaming',
            () =>
                pageRequest<AgentChatSnapshot>(page, 'agentChat.read', {
                    terminalId: shown.terminalId,
                }),
            (snapshot) => snapshot.status === 'ready',
        );
        await hideDevelopmentChrome(running);
        await showDemoStatusBar(serial);
        await delay(SETTLE_MS);

        await page.screenshot({
            path: join(captureDirectory, 'desktop.png'),
            animations: 'disabled',
        });
        await captureMobileFramebuffer(serial, join(captureDirectory, 'mobile.png'));
        await writeFile(
            join(captureDirectory, 'receipt.json'),
            `${JSON.stringify(
                {
                    scene: scene.name,
                    desktop: {
                        width: scene.desktop.width * DESKTOP_CAPTURE_SCALE,
                        height: scene.desktop.height * DESKTOP_CAPTURE_SCALE,
                    },
                    sessions: sessions.map(({ scene: session }) => ({
                        key: session.key,
                        agent: session.agent,
                        expect: session.expect,
                    })),
                },
                null,
                2,
            )}\n`,
        );
    } finally {
        // Release held turns so the fake Agents end on their own before the app closes them.
        await rm(control, { recursive: true, force: true });
        if (running) {
            try {
                await pageRequest(running.page, 'mobile.access.disable');
            } catch {
                // Closing the isolated profile also ends mobile access.
            }
            await running.app.close();
        }
        await rm(directory, { recursive: true, force: true });
    }
});
