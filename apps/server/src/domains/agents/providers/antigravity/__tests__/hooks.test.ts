import { describe, expect, it } from 'vitest';

import type { DesiredHookInstall } from '../../../hooks/contract';
import { antigravityHookAdapter } from '../hooks';

const environment = { homeDirectory: '/Users/me', variables: {} };
const desired: DesiredHookInstall = {
    bridgePath: '/Library/Application Support/Caxri/hooks/caxri-agent-hook-bridge',
    provider: 'antigravity',
    schemaVersion: antigravityHookAdapter.schemaVersion,
};

function render(source: string | undefined, install = desired): string {
    return antigravityHookAdapter.render(new Map([['hooks', source]]), install)[0].source;
}

function inspect(source: string | undefined) {
    return antigravityHookAdapter.inspect(new Map([['hooks', source]]), desired).status;
}

describe('Antigravity hook adapter', () => {
    it('writes the global hooks file under ~/.gemini/config', () => {
        expect(antigravityHookAdapter.configTargets(environment)).toEqual([
            { id: 'hooks', path: '/Users/me/.gemini/config/hooks.json', writable: true },
        ]);
    });

    it('installs one named hook whose handlers run the bridge through a shell and reply with JSON', () => {
        const document = JSON.parse(render(undefined)) as Record<
            string,
            Record<string, Array<{ type: string; command: string; timeout: number }>>
        >;
        expect(Object.keys(document)).toEqual(['caxri']);
        expect(Object.keys(document.caxri)).toEqual(['PreInvocation', 'Stop']);
        const [handler] = document.caxri.Stop;
        expect(handler.type).toBe('command');
        expect(handler.command).toMatch(/^\/bin\/sh -c '/u);
        expect(handler.command).toContain(
            '--source caxri --provider antigravity --phase turnFinished --schema 1 --reply empty-json',
        );
        expect(inspect(render(undefined))).toEqual({ kind: 'current' });
    });

    it("keeps another tool's named hook across install and removal", () => {
        const foreign = `${JSON.stringify({ other: { Stop: [{ type: 'command', command: 'true' }] } }, null, 2)}\n`;
        expect(inspect(foreign)).toEqual({ kind: 'absent' });
        const installed = render(foreign);
        expect(JSON.parse(installed)).toHaveProperty('other');
        const [removal] = antigravityHookAdapter.remove(new Map([['hooks', installed]]), desired);
        expect(JSON.parse(removal.source)).toEqual(JSON.parse(foreign));
    });

    it('repairs an older schema and leaves a newer one alone', () => {
        const older = render(undefined, { ...desired, schemaVersion: 0 });
        expect(inspect(older)).toEqual({ kind: 'stale', installedSchema: 0 });
        const newer = render(undefined, { ...desired, schemaVersion: 2 });
        expect(inspect(newer)).toEqual({ kind: 'newer', installedSchema: 2 });
        expect(antigravityHookAdapter.remove(new Map([['hooks', newer]]), desired)).toEqual([]);
    });

    it('reports an edited entry as drifted and never rewrites a malformed file', () => {
        const edited = JSON.parse(render(undefined)) as { caxri: Record<string, unknown> };
        delete edited.caxri.Stop;
        expect(inspect(JSON.stringify(edited))).toEqual({ kind: 'drifted' });
        expect(inspect('{ not json')).toMatchObject({ kind: 'unparseable' });
        expect(() => render('{ not json')).toThrow('invalid');
    });

    it('reports failed turns, which the bridge derives from a Stop', () => {
        expect(antigravityHookAdapter.supports('1.4.11')).toEqual({
            supported: true,
            phases: ['turnStarted', 'turnFinished', 'turnFailed'],
        });
    });
});
