import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalHostRuntime } from '../runtime';
import {
    cleanupRuntimeFixtures,
    createRuntime,
    fakeEngine,
    lifecycleScope,
    privateRequest,
    terminal,
} from './runtime-fixtures';

afterEach(cleanupRuntimeFixtures);

const dark = { background: '#282a36', foreground: '#f8f8f2' };
const light = { background: '#ffffff', foreground: '#000000' };

function colorsOf(runtime: TerminalHostRuntime): Map<string, unknown> {
    return (runtime as unknown as { colors: Map<string, unknown> }).colors;
}

/**
 * The OSC 10/11 responder reads these colors on every query, so `terminal.configure` must replace what the launch
 * stored: a system appearance switch otherwise leaves a running TUI answering with the colors it started under.
 */
describe('architecture-a3b-terminal-host: Terminal color refresh', () => {
    it('replaces the launch colors of a running Terminal and keeps them when a configure carries none', async () => {
        const { runtime } = createRuntime(fakeEngine().owner);
        await runtime.accept(
            privateRequest(
                { method: 'terminal.reserve', params: terminal },
                lifecycleScope(1, terminal.id),
                'reserve-1',
            ),
        );
        await runtime.accept(
            privateRequest(
                {
                    method: 'terminal.start',
                    params: {
                        record: terminal,
                        executable: '/bin/zsh',
                        args: [],
                        environment: {},
                        colors: dark,
                    },
                },
                lifecycleScope(1, terminal.id),
                'start-1',
            ),
        );
        expect(colorsOf(runtime).get(terminal.id)).toEqual(dark);

        const configure = (parameters: { colors?: typeof light }, id: string) =>
            runtime.accept(
                privateRequest(
                    { method: 'terminal.configure', params: parameters },
                    lifecycleScope(1, terminal.id),
                    id,
                ),
            );
        await configure({ colors: light }, 'configure-1');
        expect(colorsOf(runtime).get(terminal.id)).toEqual(light);

        await configure({}, 'configure-2');
        expect(colorsOf(runtime).get(terminal.id)).toEqual(light);
    });
});
