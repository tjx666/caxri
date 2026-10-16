import { join, resolve } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import {
    createE2EAgentEnvironment,
    e2eAgentEnvironmentKeys,
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
} from '@caxri/system';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

import type { DesktopLeaseHandle } from '../../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import {
    acquireDesktopLease,
    beginDesktopLeaseHandoff,
    releaseDesktopLease,
    transferDesktopLease,
} from '../../.agents/skills/switch-worktree/scripts/desktop-lease.ts';
import { createE2ELaunchTimer } from '../../scripts/reporters/public-e2e-diagnostics.ts';
import { stubAppQuitDecision } from './app-quit.ts';
import { assertE2EBuildIsFresh } from './build-freshness.ts';
import type { ClipboardCapability, ClipboardSnapshot } from './clipboard.ts';
import {
    armClipboardRestoreOnQuit,
    createClipboardCapability,
    restoreClipboard,
    snapshotClipboard,
    writeClipboardFixture,
} from './clipboard.ts';
import { closeE2EApp } from './desktop-lease-lifecycle.ts';
import type { E2EApp } from './electron-app.ts';
import { flushE2EErrorToasts, registerE2ELaunch } from './error-gate.ts';
import { releaseE2EHost } from './host-shutdown.ts';
import type { E2EAgentMode, LaunchCaxriOptions } from './launch-options.ts';
import { waitForRuntimeReady } from './runtime-ready.ts';
import { stageDevelopmentTestExtension } from './test-extension.ts';
import { resolveE2ELaunchPolicy, resolveE2EWorkerIsolation } from './worker-isolation.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const agentEnvironmentKeys = e2eAgentEnvironmentKeys();

export type { LaunchCaxriOptions } from './launch-options.ts';
export { runtimeStatus, waitForRuntimeReady } from './runtime-ready.ts';

export interface RunningCaxri {
    app: E2EApp;
    clipboard?: ClipboardCapability;
    page: Page;
}

export interface RunningCaxriWithClipboard extends RunningCaxri {
    clipboard: ClipboardCapability;
}

async function e2eAgentEnvironment(
    userDataDirectory: string,
    agentMode: E2EAgentMode,
    sourceEnvironment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
    /**
     * Preserve the host Shell PATH fallback without granting ambient provider state to real mode.
     */
    const explicitEnvironmentWithPath = {
        ...sourceEnvironment,
        PATH: sourceEnvironment.PATH ?? process.env.PATH,
    };
    return createE2EAgentEnvironment({
        fixtureRoot: join(userDataDirectory, 'e2e-agents'),
        mode:
            agentMode.mode === 'real'
                ? { ...agentMode, provider: agentMode.provider ?? 'codex' }
                : agentMode,
        sourceEnvironment: explicitEnvironmentWithPath,
    });
}

/**
 * Opens a new Terminal in the active pane through the `terminal.new` keybinding.
 *
 * The tab bar's "+" button is deliberately not the path here: it is hidden until the Workbench holds a second tab (see
 * `PaneTabBar`'s `hasTabsToSwitch`), so a spec that clicks it right after `createProjectSession` would be asserting
 * against chrome that is not there. `cmd+t` is reachable at every tab count and is the same command the button
 * invokes.
 */
export async function pressNewTerminal(page: Page): Promise<void> {
    await page.keyboard.press('Meta+t');
}

/**
 * Waits for the asynchronous New Terminal action to become observable through Runtime state.
 */
export async function waitForNewTerminalId(
    page: Page,
    existingIds: readonly string[],
): Promise<string> {
    let newTerminalId: string | undefined;
    await expect
        .poll(async () => {
            const bootstrap = await pageRequest<{ terminals: Array<{ id: string }> }>(
                page,
                'app.bootstrap',
            );
            newTerminalId = bootstrap.terminals.find(
                (terminal) => !existingIds.includes(terminal.id),
            )?.id;
            return newTerminalId;
        })
        .toBeTruthy();
    return newTerminalId!;
}

/**
 * Launches the Caxri Electron app for e2e tests without waiting for the Runtime to become ready. Most specs should use
 * {@link launchCaxri} instead; this lower-level entry point exists for specs (eg. the startup benchmark) that need to
 * measure the readiness wait themselves.
 */
export function launchCaxriApp(
    options: LaunchCaxriOptions & { clipboard: true },
): Promise<RunningCaxriWithClipboard>;
export function launchCaxriApp(options: LaunchCaxriOptions): Promise<RunningCaxri>;
export async function launchCaxriApp(options: LaunchCaxriOptions): Promise<RunningCaxri> {
    const markStage = createE2ELaunchTimer(options.onLaunchStage);
    await assertE2EBuildIsFresh();
    markStage('freshnessMs');
    const {
        userDataDir,
        testRootPath,
        env: environment = {},
        executablePath,
        desktopLeaseWaitMs,
        gpuMode = 'disabled',
        windowMode = 'hidden',
        agentMode = { mode: 'blocked' },
        quitDecisionOnClose,
        preserveHostOnClose = false,
        clipboard = false,
        clipboardFixture,
    } = options;
    const closeDecision = quitDecisionOnClose ?? (preserveHostOnClose ? 'keep-running' : 'stop');
    if (!executablePath) await stageDevelopmentTestExtension(projectRoot, userDataDir);
    const agentEnvironment = await e2eAgentEnvironment(userDataDir, agentMode, environment);
    markStage('agentEnvironmentMs');
    const clipboardPolicy = resolveE2ELaunchPolicy(process.env, { clipboard, gpuMode, windowMode });
    if (clipboardFixture && !clipboard) {
        throw new Error('clipboardFixture requires clipboard access');
    }
    const workerIsolation = resolveE2EWorkerIsolation(process.env);
    const launchEnvironmentSource: NodeJS.ProcessEnv = {
        ...process.env,
        ...environment,
        ...agentEnvironment,
        CAXRI_E2E: '1',
        CAXRI_E2E_WINDOW_MODE: windowMode,
        CAXRI_USER_DATA_DIR: userDataDir,
        CAXRI_TEST_ROOT_PATH: testRootPath,
        ...(workerIsolation.workerNamespace && {
            CAXRI_E2E_WORKER_NAMESPACE: workerIsolation.workerNamespace,
        }),
    };
    /**
     * Prevent ambient internal test switches from adding an undeclared fake provider.
     */
    for (const key of agentEnvironmentKeys) {
        if (!Object.hasOwn(agentEnvironment, key)) delete launchEnvironmentSource[key];
    }
    /**
     * The Acceptance-only Extension Host fault sequence would otherwise be inherited from the developer's shell and
     * kill the Host on every E2E launch. The Acceptance launcher strips it the same way.
     */
    delete launchEnvironmentSource[EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY];
    const launchEnvironment = Object.fromEntries(
        Object.entries(launchEnvironmentSource).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
    let lease: DesktopLeaseHandle = await acquireDesktopLease(
        projectRoot,
        executablePath ? 'performance benchmark' : 'Electron E2E',
        process.pid,
        {
            coordinatorToken: workerIsolation.coordinatorToken,
            namespace: workerIsolation.leaseNamespace,
            waitMs: desktopLeaseWaitMs,
        },
    );
    let releasePromise: Promise<void> | undefined;
    markStage('leaseAcquireMs');
    const releaseLease = (): Promise<void> =>
        (releasePromise ??= releaseE2EHost(userDataDir, preserveHostOnClose, () =>
            releaseDesktopLease(lease),
        ));
    let app: ElectronApplication;
    let clipboardBaseline: ClipboardSnapshot | undefined;
    let clipboardSnapshot: ClipboardSnapshot | undefined;
    try {
        lease = await beginDesktopLeaseHandoff(lease);
        markStage('leaseHandoffMs');
        app = await electron.launch({
            ...(executablePath && { executablePath }),
            // Specs assert English copy; pinning Chromium's locale keeps the system-following language English.
            args: [
                ...(executablePath ? [] : ['apps/desktop']),
                ...(gpuMode === 'enabled' ? [] : ['--disable-gpu']),
                '--lang=en-US',
            ],
            cwd: projectRoot,
            env: launchEnvironment,
        });
        markStage('electronLaunchMs');
        let clipboardRestoreFailure: Error | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> =>
            (cleanupPromise ??= (async () => {
                let failure: unknown;
                try {
                    await clipboardSnapshot?.dispose();
                } catch (error) {
                    clipboardRestoreFailure =
                        error instanceof Error
                            ? error
                            : new Error('E2E clipboard cleanup failed with a non-Error value');
                    failure = clipboardRestoreFailure;
                }
                try {
                    const outcome = await clipboardSnapshot?.restoreOutcome();
                    if (clipboardBaseline && outcome?.status !== 'skipped-external-write') {
                        if (outcome?.status === 'restored') {
                            clipboardBaseline.claimGeneration(outcome.generation);
                        }
                        await clipboardBaseline.restore();
                    }
                    await clipboardBaseline?.dispose();
                } catch (error) {
                    clipboardRestoreFailure =
                        error instanceof Error
                            ? error
                            : new Error('E2E clipboard cleanup failed with a non-Error value');
                    failure ??= clipboardRestoreFailure;
                }
                try {
                    await releaseLease();
                } catch (error) {
                    failure ??= error;
                }
                /**
                 * Specs intentionally ignore direct close failures in `finally`; the shared error gate awaits this
                 * cleanup promise too, so carrying a clipboard failure here keeps it observable after Electron closes.
                 */
                failure ??= clipboardRestoreFailure;
                if (failure) {
                    throw failure instanceof Error
                        ? failure
                        : new Error('E2E cleanup failed with a non-Error value');
                }
            })());
        try {
            await registerE2ELaunch(app, userDataDir, cleanup);
            markStage('errorGateRegisterMs');
            if (clipboardPolicy.protectClipboard) {
                if (clipboardFixture) {
                    clipboardBaseline = await snapshotClipboard();
                    const fixtureMetadata = await writeClipboardFixture(clipboardFixture);
                    clipboardBaseline.claimGeneration(fixtureMetadata.generation);
                }
                clipboardSnapshot = await snapshotClipboard();
                await armClipboardRestoreOnQuit(app, clipboardSnapshot);
            }
        } catch (error) {
            let failure: unknown = error;
            try {
                await app.close();
            } catch (closeError) {
                failure ??= closeError;
            }
            try {
                await cleanup();
            } catch (cleanupError) {
                failure ??= cleanupError;
            }
            throw failure instanceof Error
                ? failure
                : new Error('E2E clipboard setup failed with a non-Error value');
        }
        const activeClipboardSnapshot = clipboardSnapshot;
        const electronProcess = app.process();
        const close = app.close.bind(app);
        let handBackLeasePromise: Promise<void> | undefined;
        const handBackLease = (): Promise<void> =>
            (handBackLeasePromise ??= (async () => {
                if (cleanupPromise) return;
                lease = await transferDesktopLease(lease, process.pid);
            })());
        Object.defineProperty(app, 'close', {
            configurable: true,
            value: () =>
                closeE2EApp({
                    applicationProcess: electronProcess,
                    cleanup,
                    close,
                    handBackLease,
                    prepareBeforeClose: async () => {
                        await flushE2EErrorToasts(app);
                        await stubAppQuitDecision(app, closeDecision);
                    },
                    ...(activeClipboardSnapshot && {
                        restoreBeforeClose: async () => {
                            try {
                                await restoreClipboard(activeClipboardSnapshot);
                            } catch (error) {
                                clipboardRestoreFailure =
                                    error instanceof Error
                                        ? error
                                        : new Error(
                                              'E2E clipboard restoration failed with a non-Error value',
                                          );
                                throw clipboardRestoreFailure;
                            }
                        },
                    }),
                }),
        });
        const electronPid = electronProcess.pid;
        if (!electronPid) throw new Error('Could not establish the Electron process identity');
        markStage('lifecycleSetupMs');
        lease = await transferDesktopLease(lease, electronPid);
        markStage('leaseTransferMs');
    } catch (error) {
        await releaseLease();
        throw error;
    }
    try {
        const page = await app.firstWindow();
        markStage('firstWindowMs');
        if (clipboard && !clipboardSnapshot) {
            throw new Error('Clipboard access was declared without an active protected snapshot');
        }
        return {
            app,
            ...(clipboardSnapshot &&
                clipboard && { clipboard: createClipboardCapability(app, clipboardSnapshot) }),
            page,
        };
    } catch (error) {
        try {
            await app.close();
        } catch {
            // Ignore close failures while unwinding a failed launch.
        }
        try {
            await releaseLease();
        } catch {
            // Ignore release failures while unwinding a failed launch.
        }
        throw error;
    }
}

/**
 * Launches Caxri and waits for the Runtime to report ready.
 */
export function launchCaxri(
    options: LaunchCaxriOptions & { clipboard: true },
): Promise<RunningCaxriWithClipboard>;
export function launchCaxri(options: LaunchCaxriOptions): Promise<RunningCaxri>;
export async function launchCaxri(options: LaunchCaxriOptions): Promise<RunningCaxri> {
    const running = await launchCaxriApp(options);
    const statusStartedAt = performance.now();
    await waitForRuntimeReady(running.page);
    options.onLaunchStage?.('runtimeStatusWaitMs', performance.now() - statusStartedAt);
    return running;
}

/**
 * Waits until Project creation has converged across Runtime state and the visible workbench. A dialog closing or a
 * Session card rendering alone is insufficient: hosted runners can expose either before the selected Session and its
 * first durable Terminal are available together.
 */
export async function waitForCreatedSession(
    page: Page,
    previousSessionId?: string,
): Promise<string> {
    let createdSessionId: string | undefined;
    await expect
        .poll(async () => {
            const state = await pageRequest<{
                selectedSessionId?: string;
                sessions: Array<{ id: string }>;
                terminals: Array<{ sessionId: string }>;
            }>(page, 'app.bootstrap');
            const candidate = state.selectedSessionId;
            if (
                !candidate ||
                candidate === previousSessionId ||
                state.sessions.every(({ id }) => id !== candidate) ||
                state.terminals.every(({ sessionId }) => sessionId !== candidate) ||
                (await page.getByRole('dialog').count()) > 0 ||
                (await sessionCard(page, candidate).count()) === 0
            ) {
                return;
            }
            createdSessionId = candidate;
            return candidate;
        })
        .toBeTruthy();
    return createdSessionId!;
}

/**
 * Activates a Terminal choice through its keyboard contract. The choice handler synchronously closes the dialog, so a
 * pointer click can observe the button detaching after its click event already created the Session and then retry the
 * action until timeout. Enter dispatches the same accessible activation without waiting on the removed pointer target.
 */
export async function chooseDefaultTerminal(page: Page, name: string): Promise<void> {
    const choice = page.getByRole('dialog').getByRole('button', { exact: true, name });
    await choice.focus();
    await expect(choice).toBeFocused();
    await choice.press('Enter');
}

/**
 * The Project row's New Session button anchors a menu rather than opening the centered dialog. Activation goes through
 * the same keyboard contract as {@link chooseDefaultTerminal} and for the same reason: committing the choice
 * synchronously closes the menu, so a pointer click can observe its target detaching mid-click.
 */
export async function chooseTerminalFromCreateMenu(page: Page, name: string): Promise<void> {
    const menu = page.getByRole('menu');
    const choice = menu.getByRole('menuitem', { exact: true, name });
    await expect(choice).toBeVisible();
    /**
     * Base UI's floating focus manager claims focus for a freshly opened Menu one animation frame after the open, and
     * its guard against clobbering a focus that arrived first samples the document before that frame. `press` focuses
     * its target and dispatches the key as two separate steps, so a focus landing inside that window is read as
     * "already inside" and the queued frame still pulls focus onto the popup. The Enter then arrives on the Menu rather
     * than the item and activates nothing: no Session is created and the Menu stays open holding focus. The claim is
     * one-shot, so letting it land first closes the window.
     */
    await expect
        .poll(() => menu.evaluate((popup) => popup.contains(document.activeElement)))
        .toBe(true);
    await choice.press('Enter');
}

/**
 * Opens the "Add Project" dialog, picks the requested default Terminal, and returns only after the new Session
 * satisfies {@link waitForCreatedSession}. Specs that also need a writable Shell surface should use
 * {@link createShellSession} instead.
 */
export async function createProjectSession(
    page: Page,
    kind: 'shell' | AgentProvider = 'shell',
): Promise<string> {
    const previous = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    await openAddProjectDialog(page);
    await expect(page.getByRole('heading', { name: 'Choose the default Terminal' })).toBeVisible();
    await chooseDefaultTerminal(
        page,
        kind === 'shell' ? 'Shell' : agentProviderCatalog[kind].displayName,
    );
    return waitForCreatedSession(page, previous.selectedSessionId);
}

/**
 * The primarySidebar hosts no Add Project button; the default `Cmd+O` keybinding is the primary entry point.
 */
export async function openAddProjectDialog(page: Page): Promise<void> {
    await page.keyboard.press('Meta+o');
}

/**
 * Closes the Electron app during teardown without letting an already-closed app fail the test: a spec that asserts
 * quit, or one whose app died on the way to the assertion, would otherwise report the teardown instead of the cause.
 */
export async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

/**
 * The Workbench subtree of the Session the user can actually see.
 *
 * Session keep-alive leaves recently used Sessions' Workbench subtrees mounted behind a `hidden` wrapper so their xterm
 * buffers and Editor models survive a switch. Every pane, tab, and Terminal inside a retained Session therefore keeps
 * matching a bare `.workbench-pane` / `.work-tab` / `.xterm-helper-textarea`, which turns into a strict-mode violation
 * once a spec has visited more than one Session, or worse, into `.last()` quietly resolving to a Terminal nobody is
 * looking at, because a hidden element can never take focus. Prefix any Workbench selector with this when the spec does
 * not already pin a Terminal id.
 */
export const VISIBLE_SESSION = '.workbench-session:not([hidden])';
/**
 * The Terminal input inside the Session the user can actually see. See {@link VISIBLE_SESSION}.
 */
export const VISIBLE_TERMINAL_INPUT = `${VISIBLE_SESSION} .xterm-helper-textarea`;

export async function createShellSession(page: Page): Promise<void> {
    await createProjectSession(page, 'shell');
    const terminalInput = page.locator(VISIBLE_TERMINAL_INPUT);
    await expect(terminalInput).toBeVisible();
    /**
     * The initial Terminal focus effect is part of creation completing, not caller setup.
     */
    await expect(terminalInput).toBeFocused();
}

export async function createAdditionalShellSession(page: Page): Promise<void> {
    const before = await pageRequest<{
        selectedSessionId?: string;
        terminals: Array<{ id: string }>;
    }>(page, 'app.bootstrap');
    if (!before.selectedSessionId) throw new Error('No Session selected before creation');
    await page
        .locator('.project-heading')
        .filter({ has: page.getByRole('button', { name: /^New Session in / }) })
        .hover();
    await page.getByRole('button', { name: /^New Session in / }).click();
    await chooseTerminalFromCreateMenu(page, 'Shell');
    /**
     * Opening the action requires hovering the Project heading. Park the pointer in the Workbench after activation so
     * the trigger's delayed tooltip cannot cover a caller's next click or leave the Project in a synthetic hover
     * state.
     */
    await page.mouse.move(500, 300);
    await expect(page.locator('.tooltip-popup')).toHaveCount(0);
    const terminalId = await waitForNewTerminalId(
        page,
        before.terminals.map((terminal) => terminal.id),
    );
    await expect.poll(() => selectedSessionId(page)).not.toBe(before.selectedSessionId);
    await expect(
        page.locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`),
    ).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function typeTerminal(
    page: Page,
    command: string,
    terminalId?: string,
): Promise<void> {
    const pane = terminalId
        ? page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`)
        : page.locator(`${VISIBLE_SESSION} .terminal-pane`).last();
    await expect(pane.locator('.terminal-surface')).toHaveAttribute(
        'data-terminal-attached',
        'true',
    );
    const input = pane.locator('.xterm-helper-textarea');
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

export { clickTerminalLink, hoverTerminalLink, terminalTextBounds } from './terminal-links.ts';

export type PageReply<T> =
    { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

/**
 * Calls the preload bridge from inside the page and returns the raw reply envelope. `window.caxri` resolves instead of
 * rejecting because `contextBridge` copies only `message` and `stack` off a thrown error, so the Caxri error code has
 * to travel as data. Use this when a spec asserts a failure; use {@link pageRequest} when it only needs the result.
 */
export function pageReply<T>(
    page: Page,
    method: string,
    parameters?: unknown,
): Promise<PageReply<T>> {
    return page.evaluate(
        ([requestMethod, requestParameters]) =>
            (
                globalThis as unknown as {
                    caxri: { request(method: string, parameters_?: unknown): Promise<unknown> };
                }
            ).caxri.request(requestMethod, requestParameters),
        [method, parameters] as const,
    ) as Promise<PageReply<T>>;
}

export async function pageRequest<T>(page: Page, method: string, parameters?: unknown): Promise<T> {
    const reply = await pageReply<T>(page, method, parameters);
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply.result;
}

export async function selectedSessionId(page: Page): Promise<string> {
    const state = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    if (!state.selectedSessionId) throw new Error('No Session selected');
    return state.selectedSessionId;
}

export function sessionCard(page: Page, sessionId: string) {
    return page.locator(`.session-card[data-session-id="${sessionId}"]`);
}

/**
 * Reveals a Panel view and returns its tab. The Panel is closed at rest, so its tabs are not in the DOM until
 * `Command+J` opens the region; the toggle is idempotent here only because the panel is asserted closed first.
 */
export async function openPanelView(page: Page, name: 'Info' | 'Logs'): Promise<Locator> {
    const tablist = page.getByRole('tablist', { name: 'Panel' });
    if ((await tablist.count()) === 0) {
        await page.keyboard.press('Meta+j');
        await expect(tablist).toBeVisible();
    }
    const tab = tablist.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return tab;
}

/**
 * Splits an existing Terminal by exercising the same tab-to-pane drag gesture as a user.
 */
export async function splitTerminalToRight(page: Page, terminalId: string): Promise<void> {
    await expect(page.locator(`.work-tab[data-terminal-id="${terminalId}"]`)).toBeAttached();
    await expect(page.locator('.pane-surface').first()).toBeAttached();
    await page.evaluate((draggedTerminalId) => {
        const source = document.querySelector(
            `.work-tab[data-terminal-id="${CSS.escape(draggedTerminalId)}"]`,
        );
        // The actual drop listeners live on `.pane-surface`, the content area beneath a pane's tab bar, not on the
        // outer `.workbench-pane` box.
        const target = document.querySelector('.pane-surface');
        if (!source || !target) throw new Error('Terminal split drag fixture not found');
        const transfer = new DataTransfer();
        const bounds = target.getBoundingClientRect();
        const options = {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * 0.9,
            clientY: bounds.top + bounds.height * 0.5,
            dataTransfer: transfer,
        };
        source.dispatchEvent(new DragEvent('dragstart', options));
        target.dispatchEvent(new DragEvent('dragenter', options));
        target.dispatchEvent(new DragEvent('dragover', options));
        target.dispatchEvent(new DragEvent('drop', options));
        source.dispatchEvent(new DragEvent('dragend', options));
    }, terminalId);
}

/**
 * Presses `Cmd+,` and returns the Settings surface, scoped by `data-settings-page`. Settings is a Workbench document
 * tab (`caxri-settings://workbench`), not a modal, so there is no `role="dialog"` left to query within: this attribute
 * is the replacement scope every Settings-touching test should use in its place. Reissuing `Cmd+,` while the tab is
 * already open focuses it rather than duplicating it, so this is also the right call for "come back to Settings" after
 * navigating elsewhere in the Workbench.
 */
export async function openSettingsTab(page: Page): Promise<Locator> {
    await page.keyboard.press('Meta+,');
    const panel = page.locator('[data-settings-page]');
    await expect(panel).toBeVisible();
    return panel;
}

/**
 * Scrolls the virtualized Settings list to a category or subcategory by clicking its table of contents entry. Rows
 * outside the viewport are not in the DOM at all (virtual rendering), so tests must reveal a section before interacting
 * with its rows.
 */
export async function revealSettingsSection(dialog: Locator, name: string): Promise<void> {
    await dialog
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name, exact: true })
        .click();
}

/**
 * Waits for a revision-bound action to stop targeting a snapshot currently being refreshed.
 */
export async function waitForSourceControlReady(page: Page): Promise<void> {
    const tree = page.locator('.git-repositories[role="tree"]');
    await expect(tree).toBeVisible();
    await expect(tree).not.toHaveAttribute('aria-busy', 'true');
}

/**
 * Clicks a Source Control group toolbar action, such as `Open Changes` or `Discard All Changes`.
 *
 * Those buttons are revealed on hover or focus, the way VS Code reveals `.resource-group > .actions`: leaving the
 * repository-wide destructive action permanently on screen while the narrower per-file one hid behind hover inverted
 * the risk gradient. Playwright's `click()` waits for visibility instead of creating it, so a test has to reveal the
 * toolbar the same way a user does: by putting the pointer on the caption row that owns it.
 *
 * The action is addressed by `aria-label` rather than by role: until the caption is hovered the button is `display:
 * none`, which takes it out of the accessibility tree, so `getByRole` cannot find the very element whose toolbar we are
 * trying to reveal. `filter({ has })` also re-roots its inner locator under each candidate, so that one is built from
 * `page` instead of chaining off `repo`.
 */
export async function clickGitGroupAction(repo: Locator, name: string): Promise<void> {
    // `JSON.stringify` quotes the value: a label carrying a quote would otherwise produce an invalid-selector parse
    // error instead of a legible missing-element failure.
    const selector = `.git-changes-actions button[aria-label=${JSON.stringify(name)}]`;
    const caption = repo
        .locator('.git-changes-caption')
        .filter({ has: repo.page().locator(selector) });
    await caption.hover();
    await waitForSourceControlReady(repo.page());
    await caption.locator(selector).click();
}

/**
 * Clicks a Source Control per-file row action, such as `Discard changes in tracked.txt`.
 *
 * Same reveal-on-hover contract as {@link clickGitGroupAction}, one level down: the action lives on the file row, so the
 * pointer has to be on that row. Selecting the row first happens to leave the pointer there, which is why a test that
 * opens the file's diff before discarding it can look like it needs no hover at all, until a step in between moves the
 * pointer somewhere else and the button is `display: none` again.
 */
export async function clickGitFileAction(
    repo: Locator,
    fileName: string,
    name: string,
): Promise<void> {
    await repo.getByRole('treeitem', { name: fileName, exact: true }).hover();
    await waitForSourceControlReady(repo.page());
    await repo.getByRole('button', { name, exact: true }).click();
}
