import { describe, expect, it, vi } from 'vitest';

import { AgentMessagingCapabilityProbe } from '..';

const launch = { executable: 'codex', args: [] };

describe('AgentMessagingCapabilityProbe', () => {
    it('detects verified pull, disabled, missing, unsupported, and fake fixtures', async () => {
        const verified = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: false,
            now: () => 1,
            probe: () =>
                Promise.resolve({ executable: '/bin/codex', version: 'codex-cli 0.147.0' }),
        });
        await expect(
            verified.check({ enabled: true, launch, provider: 'codex' }),
        ).resolves.toMatchObject({
            deliveryMode: 'pull',
            health: 'ready',
            reason: 'pull_ready',
        });
        await expect(
            verified.check({ enabled: false, launch, provider: 'codex' }),
        ).resolves.toMatchObject({
            deliveryMode: 'unavailable',
            reason: 'integration_disabled',
        });

        const missing = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            probe: () => Promise.resolve({}),
        });
        await expect(
            missing.check({ enabled: true, launch, provider: 'codex' }),
        ).resolves.toMatchObject({
            deliveryMode: 'unavailable',
            reason: 'provider_missing',
        });

        const future = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: false,
            probe: () => Promise.resolve({ executable: '/bin/codex', version: 'codex-cli 1.0.0' }),
        });
        await expect(
            future.check({ enabled: true, launch, provider: 'codex' }),
        ).resolves.toMatchObject({
            deliveryMode: 'unavailable',
            reason: 'version_unsupported',
        });

        const fixture = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: true,
            probe: () =>
                Promise.resolve({ executable: '/fixture/codex', version: 'fixture 99.0.0' }),
        });
        await expect(
            fixture.check({ enabled: true, launch, provider: 'codex' }),
        ).resolves.toMatchObject({
            deliveryMode: 'pull',
            reason: 'fixture_pull_ready',
        });
    });

    it('bounds probes, caches success, and invalidates by provider', async () => {
        vi.useFakeTimers();
        try {
            const providerProbe = vi.fn(() =>
                Promise.resolve({ executable: '/bin/claude', version: '2.1.231' }),
            );
            const probe = new AgentMessagingCapabilityProbe({
                cliAvailable: () => Promise.resolve(true),
                cliPath: '/caxri',
                fixtureMode: false,
                now: () => 1,
                probe: providerProbe,
                timeoutMs: 10,
            });
            await probe.check({
                enabled: true,
                launch: { executable: 'claude', args: [] },
                provider: 'claude',
            });
            await probe.check({
                enabled: true,
                launch: { executable: 'claude', args: [] },
                provider: 'claude',
            });
            expect(providerProbe).toHaveBeenCalledTimes(1);
            probe.invalidate('claude');
            await probe.check({
                enabled: true,
                launch: { executable: 'claude', args: [] },
                provider: 'claude',
            });
            expect(providerProbe).toHaveBeenCalledTimes(2);

            const blocked = new AgentMessagingCapabilityProbe({
                cliAvailable: () => Promise.resolve(true),
                cliPath: '/caxri',
                probe: () => new Promise(() => {}),
                timeoutMs: 10,
            });
            const pending = blocked.check({ enabled: true, launch, provider: 'codex' });
            await vi.advanceTimersByTimeAsync(10);
            await expect(pending).resolves.toMatchObject({ reason: 'probe_timeout' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('coalesces identical concurrent provider and launch checks', async () => {
        const result = Promise.withResolvers<{ executable: string; version: string }>();
        const providerProbe = vi.fn(() => result.promise);
        const probe = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: false,
            probe: providerProbe,
        });
        const input = {
            enabled: true,
            launch: { executable: 'codex', args: ['--profile', 'shared'] },
            provider: 'codex' as const,
        };

        const first = probe.check(input);
        const second = probe.check({
            ...input,
            launch: { ...input.launch, args: [...input.launch.args] },
        });
        await vi.waitFor(() => expect(providerProbe).toHaveBeenCalledOnce());
        result.resolve({ executable: '/bin/codex', version: 'codex-cli 0.147.0' });

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ deliveryMode: 'pull', reason: 'pull_ready' }),
            expect.objectContaining({ deliveryMode: 'pull', reason: 'pull_ready' }),
        ]);
    });
});
