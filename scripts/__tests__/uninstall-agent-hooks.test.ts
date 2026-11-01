import type { AgentProvider } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentProviders } from '../../apps/server/src/domains/agents/providers';
import { antigravityHookAdapter } from '../../apps/server/src/domains/agents/providers/antigravity/hooks';
import { planHookConfigCleanups } from '../uninstall-agent-hooks';

describe('planHookConfigCleanups', () => {
    it("removes Caxri's named Antigravity hook and keeps the user's own", async () => {
        const environment = { homeDirectory: '/Users/me', variables: {} };
        const [target] = antigravityHookAdapter.configTargets(environment);
        const foreign = `${JSON.stringify({ lint: { PreInvocation: [] } }, null, 2)}\n`;
        const [installed] = antigravityHookAdapter.render(new Map([[target.id, foreign]]), {
            bridgePath: '/opt/caxri/caxri-agent-hook-bridge',
            provider: 'antigravity',
            schemaVersion: antigravityHookAdapter.schemaVersion,
        });

        const cleanups = await planHookConfigCleanups(environment, (path) =>
            Promise.resolve(path === target.path ? installed.source : undefined),
        );

        expect(cleanups.map(({ path, provider }) => ({ path, provider }))).toEqual([
            { path: '/Users/me/.gemini/config/hooks.json', provider: 'antigravity' },
        ]);
        expect(JSON.parse(cleanups[0].source)).toEqual({ lint: { PreInvocation: [] } });
    });

    it.each(
        Object.entries(agentProviders).flatMap(([provider, { hooks }]) =>
            hooks ? [{ provider: provider as AgentProvider, hooks }] : [],
        ),
    )('cleans up the hooks a $provider build installed', async ({ provider, hooks }) => {
        const environment = { homeDirectory: '/Users/me', variables: {} };
        const targets = hooks.configTargets(environment);
        const emptyTargets = new Map(targets.map(({ id }) => [id, undefined]));
        const installed = new Map(
            hooks
                .render(emptyTargets, {
                    bridgePath: '/opt/caxri/caxri-agent-hook-bridge',
                    provider,
                    schemaVersion: hooks.schemaVersion,
                })
                .map(({ targetId, source }) => [
                    targets.find(({ id }) => id === targetId)?.path,
                    source,
                ]),
        );

        const cleanups = await planHookConfigCleanups(environment, (path) =>
            Promise.resolve(installed.get(path)),
        );

        expect(cleanups.map((cleanup) => cleanup.provider)).toContain(provider);
    });
});
