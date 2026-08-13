import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import { TerminalCommandTracker } from './terminal-commands';

function createTerminalHost() {
    const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const decorations: Array<{ element: HTMLElement; marker: IMarker }> = [];
    const markerDisposers: Array<ReturnType<typeof vi.fn>> = [];
    const markers: IMarker[] = [];
    const scrollToLine = vi.fn();
    let nextLine = 10;
    const terminal = {
        parser: {
            registerOscHandler: vi.fn((protocol: number, handler: (data: string) => boolean) => {
                handlers.set(protocol, handler);
                return { dispose: () => handlers.delete(protocol) };
            }),
        },
        registerDecoration: vi.fn(({ marker }: { marker: IMarker }) => {
            const classNames = new Set<string>();
            const element = {
                classList: {
                    add: (...names: string[]) => {
                        for (const name of names) classNames.add(name);
                    },
                },
                dataset: {},
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
    return { decorations, handlers, markerDisposers, markers, scrollToLine, terminal };
}

const colors = {
    failed: '#ff0000',
    prompt: '#777777',
    running: '#ffff00',
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

    it('navigates content-free command start markers in both directions', async () => {
        const host = createTerminalHost();
        const tracker = new TerminalCommandTracker(host.terminal, colors, vi.fn());
        for (const status of [0, 1, 0]) {
            await host.handlers.get(133)?.('A');
            await host.handlers.get(133)?.('C');
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
            await host.handlers.get(133)?.('A');
            await host.handlers.get(133)?.('C');
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
