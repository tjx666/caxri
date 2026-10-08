import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import {
    terminalCommandDecorationDefaultColor,
    terminalCommandDecorationFailedColor,
    terminalCommandDecorationSucceededColor,
    terminalCommandDecorationTooltip,
    TerminalCommandTracker,
} from '../terminal-command-tracker';

function createTerminalHost() {
    const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const decorations: Array<{ element: HTMLElement; marker: IMarker }> = [];
    const markerDisposers: Array<ReturnType<typeof vi.fn>> = [];
    const markers: IMarker[] = [];
    const scrollToLine = vi.fn();
    let nextLine = 10;
    const registerOscHandler = vi.fn(
        (protocol: number, canHandleOscData: (data: string) => boolean): IDisposable => {
            handlers.set(protocol, canHandleOscData);
            return { dispose: () => handlers.delete(protocol) };
        },
    );
    const terminal = {
        parser: { registerOscHandler },
        registerDecoration: vi.fn(({ marker }: { marker: IMarker }) => {
            const classNames = new Set<string>();
            const element = {
                classList: {
                    add: (...names: string[]) => {
                        for (const name of names) classNames.add(name);
                    },
                },
                dataset: {},
                style: {},
            } as unknown as HTMLElement;
            decorations.push({ element, marker });
            return {
                dispose: vi.fn(),
                element,
                marker,
                onDispose: vi.fn(),
                onRender: (listener: (target: HTMLElement) => void): IDisposable => {
                    listener(element);
                    return { dispose: vi.fn() };
                },
                options: {},
            } as unknown as IDecoration;
        }),
        registerMarker: vi.fn(() => {
            const dispose = vi.fn();
            const marker = {
                dispose,
                id: nextLine,
                isDisposed: false,
                line: nextLine++,
                onDispose: vi.fn(),
            } as unknown as IMarker;
            markerDisposers.push(dispose);
            markers.push(marker);
            return marker;
        }),
        scrollToLine,
    } as unknown as Terminal;
    return {
        decorations,
        handlers,
        markerDisposers,
        markers,
        registerOscHandler,
        scrollToLine,
        terminal,
    };
}

const colors = {
    failed: '#ff0000',
    running: '#ffffff40',
    succeeded: '#00ff00',
};

describe('TerminalCommandTracker', () => {
    it('maps OSC 133 and 633 lifecycle events without retaining command text', () => {
        const host = createTerminalHost();
        const publish = vi.fn();
        const tracker = new TerminalCommandTracker(host.terminal, colors, publish);

        expect(host.handlers.get(133)?.('A')).toBe(true);
        expect(host.handlers.get(133)?.('C')).toBe(true);
        expect(host.handlers.get(133)?.('D;0')).toBe(true);
        expect(host.handlers.get(633)?.('A')).toBe(true);
        expect(host.handlers.get(633)?.('C')).toBe(true);
        expect(host.handlers.get(633)?.('D;23;ignored metadata')).toBe(true);
        expect(host.handlers.get(133)?.('E;SECRET_COMMAND_TEXT')).toBe(false);

        expect(publish).toHaveBeenLastCalledWith({
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 23,
        });
        expect(JSON.stringify(publish.mock.calls)).not.toContain('SECRET_COMMAND_TEXT');
        expect(
            host.decorations.some(
                ({ element }) =>
                    element.dataset.terminalCommandPhase === 'failed' &&
                    element.dataset.terminalCommandExitStatus === '23',
            ),
        ).toBe(true);

        tracker.dispose();
        expect(host.handlers.size).toBe(0);
    });

    it('still releases later OSC handlers and markers when an earlier dispose throws', async () => {
        const host = createTerminalHost();
        const failure = new Error('Attempted to dispose unknown listener');
        const realRegister = host.registerOscHandler.getMockImplementation()!;
        host.registerOscHandler.mockImplementationOnce((protocol, callback) => {
            const registration = realRegister(protocol, callback);
            return {
                dispose: () => {
                    registration.dispose();
                    throw failure;
                },
            };
        });
        const tracker = new TerminalCommandTracker(host.terminal, colors, vi.fn());
        await host.handlers.get(133)?.('A');
        await host.handlers.get(133)?.('C');

        expect(() => tracker.dispose()).toThrow(failure);
        expect(host.handlers.size).toBe(0);
        for (const dispose of host.markerDisposers) expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('renders VS Code-style gutter decorations: no prompt glyph, subtle running placeholder', async () => {
        const host = createTerminalHost();
        new TerminalCommandTracker(host.terminal, colors, vi.fn());

        await host.handlers.get(133)?.('A');
        // A prompt alone must not render any decoration (VS Code shows nothing before execution).
        expect(host.decorations).toHaveLength(0);

        await host.handlers.get(133)?.('C');
        expect(host.decorations).toHaveLength(1);
        const running = host.decorations[0].element;
        expect(running.dataset.terminalCommandPhase).toBe('running');
        expect(running.style.color).toBe(colors.running);
        expect(running.style.marginLeft).toBe('-17px');
        expect(running.style.width).toBe('16px');

        await host.handlers.get(133)?.('D;0');
        const succeeded = host.decorations.at(-1)!.element;
        expect(succeeded.dataset.terminalCommandPhase).toBe('succeeded');
        expect(succeeded.style.color).toBe(colors.succeeded);
    });

    it('derives the running placeholder color from the theme foreground at 25% alpha', () => {
        expect(terminalCommandDecorationDefaultColor('#aabbcc')).toBe('#aabbcc40');
        expect(terminalCommandDecorationDefaultColor(undefined)).toBe('#ffffff40');
        expect(terminalCommandDecorationDefaultColor('red')).toBe('#ffffff40');
    });

    it('derives the failed/succeeded gutter colors from the workbench --danger/--success tokens', () => {
        expect(terminalCommandDecorationFailedColor('#aa1122')).toBe('#aa1122');
        expect(terminalCommandDecorationFailedColor(undefined)).toBe('#ff5555');
        expect(terminalCommandDecorationFailedColor('red')).toBe('#ff5555');
        expect(terminalCommandDecorationSucceededColor('#22aa11')).toBe('#22aa11');
        expect(terminalCommandDecorationSucceededColor(undefined)).toBe('#50fa7b');
        expect(terminalCommandDecorationSucceededColor('green')).toBe('#50fa7b');
    });

    it('builds the decoration hover tooltip from phase and exit status', () => {
        expect(terminalCommandDecorationTooltip('running')).toBe('Command running');
        expect(terminalCommandDecorationTooltip('succeeded', 0)).toBe('Command succeeded (exit 0)');
        expect(terminalCommandDecorationTooltip('failed', 23)).toBe('Command failed (exit 23)');
    });

    it('sets an exit-status tooltip on the rendered decoration element', async () => {
        const host = createTerminalHost();
        new TerminalCommandTracker(host.terminal, colors, vi.fn());

        await host.handlers.get(133)?.('C');
        expect(host.decorations[0].element.title).toBe('Command running');

        await host.handlers.get(133)?.('D;1');
        expect(host.decorations.at(-1)!.element.title).toBe('Command failed (exit 1)');
    });

    it('navigates content-free command start markers in both directions', async () => {
        const host = createTerminalHost();
        const tracker = new TerminalCommandTracker(host.terminal, colors, vi.fn());
        for (const status of [0, 1, 0]) {
            // Each OSC event mutates shared tracker state and must be observed in this exact
            // prompt -> command -> finish order, so the awaits cannot be parallelized.
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.('A');
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.('C');
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.(`D;${status}`);
        }

        expect(tracker.navigate('previous')).toBe(true);
        expect(tracker.navigate('previous')).toBe(true);
        expect(tracker.navigate('next')).toBe(true);
        expect(host.scrollToLine).toHaveBeenNthCalledWith(1, 14);
        expect(host.scrollToLine).toHaveBeenNthCalledWith(2, 12);
        expect(host.scrollToLine).toHaveBeenNthCalledWith(3, 14);
    });

    it('ignores finish and oversized metadata without a command boundary', () => {
        const host = createTerminalHost();
        const publish = vi.fn();
        const tracker = new TerminalCommandTracker(host.terminal, colors, publish);

        expect(host.handlers.get(133)?.('D;0')).toBe(true);
        expect(host.handlers.get(133)?.(`A;${'x'.repeat(65)}`)).toBe(false);
        expect(tracker.navigate('previous')).toBe(false);
        expect(publish).toHaveBeenLastCalledWith({ commandCount: 0, completedCount: 0 });
    });

    it('releases boundaries after xterm trims their scrollback markers', async () => {
        const host = createTerminalHost();
        const publish = vi.fn();
        new TerminalCommandTracker(host.terminal, colors, publish);
        await host.handlers.get(133)?.('A');
        await host.handlers.get(133)?.('C');
        await host.handlers.get(133)?.('D;0');
        Object.assign(host.markers[0], { isDisposed: true, line: -1 });

        await host.handlers.get(133)?.('A');
        await host.handlers.get(133)?.('C');

        expect(publish).toHaveBeenLastCalledWith({ commandCount: 1, completedCount: 0 });
    });

    it('caps untrimmed command boundaries and releases the oldest markers', async () => {
        const host = createTerminalHost();
        const publish = vi.fn();
        const tracker = new TerminalCommandTracker(host.terminal, colors, publish);

        for (let command = 0; command < 1_001; command += 1) {
            // Each OSC event mutates shared tracker state and must be observed in this exact
            // prompt -> command -> finish order, so the awaits cannot be parallelized.
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.('A');
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.('C');
            // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see above
            await host.handlers.get(133)?.('D;0');
        }

        expect(publish).toHaveBeenLastCalledWith({
            commandCount: 1_000,
            completedCount: 1_000,
            lastExitStatus: 0,
        });
        expect(host.markerDisposers[0]).toHaveBeenCalledOnce();
        expect(host.markerDisposers[1]).toHaveBeenCalledOnce();
        expect(tracker.navigate('previous')).toBe(true);
    });
});
