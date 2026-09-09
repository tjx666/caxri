import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDelegationCreate, AgentLaunchSettings } from '@caxri/protocol';
import { agentDelegationSettingsSchema } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

const owner = { principal: { kind: 'human-cli', id: 'owner' } } as const;

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-presets-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(directory);
    const { session, terminal: caller } = database.createSession(project.id, 'claude');
    let settings = agentDelegationSettingsSchema.parse({
        maxDepth: 2,
        presets: [
            {
                name: 'review',
                provider: 'claude',
                model: 'opus',
                effort: 'high',
                useWhen: 'Review changes',
                instructions: 'Use synthetic evidence only.',
            },
            { name: 'private', provider: 'claude', useWhen: 'Owner-only named selection' },
        ],
        callers: {
            claude: {
                presets: { review: { provider: 'codex', useWhen: 'Review another provider' } },
                exclude: ['private'],
            },
        },
    });
    const launches = new Map<string, string>();
    const start = vi.fn<AgentDispatchService['start']>((id, _principal, input, options) => {
        const terminal = database.createTerminal(session.id, input.provider);
        options?.prepared(terminal);
        launches.set(terminal.id, id);
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const launchSettings = vi.fn<(provider: string) => AgentLaunchSettings>((provider) => ({
        executable: provider,
        args: ['--model', 'inherited-model'],
    }));
    const service = new AgentDelegationService({
        database,
        dispatch: { start },
        userDataPath: directory,
        launchSettings,
        delegationSettings: () => settings,
        currentLaunchId: (terminalId) => launches.get(terminalId),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: () => Promise.resolve(null),
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const input = { projectId: project.id, sessionId: session.id, prompt: 'Synthetic task' };
    const agent = {
        principal: {
            kind: 'agent' as const,
            id: 'caller',
            endpointId: 'endpoint',
            generation: 1,
            projectIds: [project.id],
        },
        callerTerminalId: caller!.id,
    };
    return {
        directory,
        database,
        service,
        input,
        agent,
        launches,
        start,
        launchSettings,
        setSettings: (value: unknown) => {
            settings = agentDelegationSettingsSchema.parse(value);
        },
    };
}

describe('delegation presets and caller admission', () => {
    it('does not interpret inherited object properties as caller bindings', async () => {
        const f = await fixture();
        f.setSettings({
            presets: [
                {
                    name: 'constructor',
                    provider: 'claude',
                    model: 'opus',
                    useWhen: 'Synthetic review',
                },
            ],
            callers: { claude: { presets: {} } },
        });
        expect(f.service.presets(f.agent, f.input).presets[0]).toMatchObject({
            provider: 'claude',
            model: 'opus',
        });
        f.setSettings({
            presets: [{ name: 'constructor', provider: 'claude', useWhen: 'Synthetic review' }],
            callers: { claude: { presets: {}, exclude: ['constructor'] } },
        });
        expect(f.service.presets(f.agent, f.input).presets).toEqual([]);
    });
    it('replaces the whole selection tuple, excludes named presets and keeps instructions private', async () => {
        const f = await fixture();
        const roster = f.service.presets(f.agent, f.input);
        expect(roster.presets).toEqual([
            {
                name: 'review',
                provider: 'codex',
                model: undefined,
                effort: undefined,
                useWhen: 'Review another provider',
                dontUseWhen: undefined,
            },
        ]);
        const id = randomUUID();
        const receipt = await f.service.create(id, f.agent, { ...f.input, preset: 'review' });
        expect(receipt).toMatchObject({
            provider: 'codex',
            depth: 1,
            selection: { provider: 'codex', preset: 'review' },
        });
        expect(f.database.agentDelegations.get(id)?.frozenLaunch.args).toEqual([]);
        expect(await readFile(join(f.directory, 'delegations', id, 'task.md'), 'utf8')).toBe(
            'Use synthetic evidence only.\n\nSynthetic task',
        );
        expect(JSON.stringify(roster)).not.toContain('Synthetic evidence');
        await expect(
            f.service.create(randomUUID(), f.agent, { ...f.input, preset: 'private' }),
        ).rejects.toThrow(/unavailable/u);
        expect(f.start).toHaveBeenCalledOnce();
    });

    it('rejects forged caller identity before revealing its roster or launching', async () => {
        const f = await fixture();
        expect(() => f.service.presets(f.agent, { ...f.input, callerProvider: 'codex' })).toThrow(
            /authenticated Terminal/u,
        );
        await expect(
            f.service.create(randomUUID(), f.agent, {
                ...f.input,
                preset: 'review',
                callerProvider: 'codex',
            }),
        ).rejects.toThrow(/authenticated Terminal/u);
        expect(f.start).not.toHaveBeenCalled();
    });

    it('returns the original idempotent receipt after a preset is removed', async () => {
        const f = await fixture();
        const id = randomUUID();
        const input = { ...f.input, preset: 'review' };
        const first = await f.service.create(id, owner, input);
        f.setSettings({});
        expect(await f.service.create(id, owner, input)).toEqual(first);
        expect(f.start).toHaveBeenCalledOnce();
        await expect(f.service.create(randomUUID(), owner, input)).rejects.toThrow(/unavailable/u);
    });

    it('freezes follow-up selection and instructions despite edited configuration', async () => {
        const f = await fixture();
        const first = await f.service.create(randomUUID(), owner, { ...f.input, preset: 'review' });
        f.setSettings({});
        const next = await f.service.create(randomUUID(), owner, {
            ...f.input,
            followUpOf: first.delegationId,
        });
        expect(next.selection).toEqual(first.selection);
        expect(next.depth).toBe(1);
        expect(f.database.agentDelegations.get(next.delegationId)?.frozenInstructions).toBe(
            'Use synthetic evidence only.',
        );
        await expect(
            f.service.create(randomUUID(), owner, {
                ...f.input,
                followUpOf: first.delegationId,
                model: 'different',
            }),
        ).rejects.toThrow(/preserve/u);
    });

    it('bounds nesting using authenticated live launch ownership', async () => {
        const f = await fixture();
        const root = await f.service.create(randomUUID(), owner, {
            ...f.input,
            provider: 'claude',
        });
        f.service.bindLaunch(root.terminalId!, root.delegationId);
        const childAuthority = { ...f.agent, callerTerminalId: root.terminalId! };
        const child = await f.service.create(randomUUID(), childAuthority, {
            ...f.input,
            provider: 'claude',
        });
        expect(child).toMatchObject({ depth: 2, parentDelegationId: root.delegationId });
        f.service.bindLaunch(child.terminalId!, child.delegationId);
        const nestedAuthority = { ...f.agent, callerTerminalId: child.terminalId! };
        await expect(
            f.service.create(randomUUID(), nestedAuthority, { ...f.input, provider: 'claude' }),
        ).rejects.toThrow(/maximum depth/u);
        f.launches.set(child.terminalId!, 'human-relaunch');
        expect(
            await f.service.create(randomUUID(), nestedAuthority, {
                ...f.input,
                provider: 'claude',
            }),
        ).toMatchObject({ depth: 1 });
    });

    it('normalizes explicit model selection and refuses hidden unsafe configuration overrides', async () => {
        const f = await fixture();
        const input: AgentDelegationCreate = {
            ...f.input,
            provider: 'codex',
            model: 'gpt-5.5',
            effort: 'xhigh',
        };
        const receipt = await f.service.create(randomUUID(), owner, input);
        expect(f.database.agentDelegations.get(receipt.delegationId)?.frozenLaunch.args).toEqual([
            '--model',
            'gpt-5.5',
            '-c',
            'model_reasoning_effort="xhigh"',
        ]);
        await expect(
            f.service.create(randomUUID(), owner, { ...input, effort: 'ultra' }),
        ).rejects.toThrow(/Unsupported/u);
        f.launchSettings.mockReturnValue({
            executable: 'codex',
            args: ['-c', 'hooks.enabled=false'],
        });
        await expect(f.service.create(randomUUID(), owner, input)).rejects.toThrow();
    });
});
