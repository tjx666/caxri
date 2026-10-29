import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat permission level and plan mode with a fake Codex app-server', () => {
    it('carries a switch into the next turn, sends plan mode with every turn, and resumes with the saved level', async () => {
        const { database, fakeLog, service, terminal, threadOpens, until } = await fixture();
        expect(await until((snapshot) => snapshot.models !== undefined)).toMatchObject({
            permissionMode: 'acceptEdits',
            planMode: false,
        });

        await service.setPermission(terminal.id, { permissionMode: 'readOnly', planMode: true });
        await until(
            (snapshot) => snapshot.permissionMode === 'readOnly' && snapshot.planMode === true,
        );
        expect(database.getChatPermission(terminal.id)).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });

        await service.send(terminal.id, { text: 'first' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.send(terminal.id, { text: 'second' });
        await until(
            (snapshot) =>
                snapshot.turns.at(-1)?.status === 'completed' && snapshot.turns.length === 2,
        );
        await service.setPermission(terminal.id, { planMode: false });
        await service.send(terminal.id, { text: 'third' });
        await until(
            (snapshot) =>
                snapshot.turns.at(-1)?.status === 'completed' && snapshot.turns.length === 3,
        );

        const plan = {
            mode: 'plan',
            settings: {
                model: 'fake-codex-model',
                reasoning_effort: 'medium',
                developer_instructions: null,
            },
        };
        expect(await fakeLog('codex', 'turn-starts.jsonl')).toEqual([
            {
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandboxPolicy: { type: 'readOnly' },
                collaborationMode: plan,
            },
            // The level is already the thread's; plan mode must be named again on every turn.
            { collaborationMode: plan },
            // Turning plan mode off sends the default mode once, since Codex keeps the last one on the thread.
            { collaborationMode: { ...plan, mode: 'default' } },
        ]);

        await service.restart(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');
        expect((await threadOpens()).at(-1)).toMatchObject({
            method: 'thread/resume',
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
        });
        expect(service.read(terminal.id)).toMatchObject({
            permissionMode: 'readOnly',
            planMode: false,
        });
    });

    it('opens the auto level with the auto-review agent answering approvals', async () => {
        const { database, service, terminal, threadOpens, until } = await fixture();
        database.setChatPermission(terminal.id, { permissionMode: 'auto', planMode: false });
        await until((snapshot) => snapshot.permissionMode === 'auto');
        expect((await threadOpens()).at(-1)).toMatchObject({
            method: 'thread/start',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review',
        });
        await expect(
            service.setPermission(terminal.id, { permissionMode: 'ask' }),
        ).rejects.toMatchObject({
            code: 'VALIDATION',
        });
    });

    it("keeps config.toml's workspace-write extras when a switch rides on turn/start", async () => {
        const { fakeLog, service, setCodexWorkspaceWriteConfig, terminal, until } = await fixture();
        await setCodexWorkspaceWriteConfig({
            writable_roots: ['/extra/root', 'relative/root'],
            network_access: true,
            exclude_slash_tmp: true,
        });
        await until((snapshot) => snapshot.models !== undefined);
        await service.setPermission(terminal.id, { permissionMode: 'readOnly' });
        await service.send(terminal.id, { text: 'first' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.setPermission(terminal.id, { permissionMode: 'auto' });
        await service.send(terminal.id, { text: 'second' });
        await until(
            (snapshot) =>
                snapshot.turns.length === 2 && snapshot.turns.at(-1)?.status === 'completed',
        );
        const starts = await fakeLog('codex', 'turn-starts.jsonl');
        expect(starts.map((start) => start.sandboxPolicy)).toEqual([
            { type: 'readOnly' },
            // A relative root is dropped: the policy takes absolute paths only.
            {
                type: 'workspaceWrite',
                writableRoots: ['/extra/root'],
                networkAccess: true,
                excludeSlashTmp: true,
            },
        ]);
    });

    it('keeps following the launch settings when only plan mode changes', async () => {
        const { database, service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.models !== undefined);
        await service.setPermission(terminal.id, { planMode: true });
        await until((snapshot) => snapshot.planMode === true);
        expect(database.getChatPermission(terminal.id)).toEqual({ planMode: true });
    });

    describe('approving a proposed plan', () => {
        async function proposePlan() {
            const context = await fixture();
            const { service, terminal, until } = context;
            await until((snapshot) => snapshot.models !== undefined);
            await service.setPermission(terminal.id, {
                permissionMode: 'readOnly',
                planMode: true,
            });
            await until((snapshot) => snapshot.planMode === true);
            await service.send(terminal.id, { text: 'proposeplan refactor the parser' });
            const snapshot = await until(
                (current) =>
                    current.turns.at(-1)?.status === 'completed' &&
                    current.items.some((item) => item.type === 'agentMessage' && item.proposedPlan),
            );
            const planItem = snapshot.items.find(
                (item) => item.type === 'agentMessage' && item.proposedPlan,
            )!;
            return { ...context, planId: planItem.id };
        }

        it('leaves plan mode and starts the build turn once, keeping the permission level', async () => {
            const { database, fakeLog, planId, service, terminal, until } = await proposePlan();

            await service.implementPlan(terminal.id, planId);
            const snapshot = await until(
                (current) =>
                    current.turns.length === 2 && current.turns.at(-1)?.status === 'completed',
            );

            expect(snapshot).toMatchObject({ planMode: false, permissionMode: 'readOnly' });
            expect(snapshot.items.findLast((item) => item.type === 'userMessage')).toMatchObject({
                text: 'Implement the plan.',
            });
            expect(database.getChatPermission(terminal.id)).toMatchObject({
                permissionMode: 'readOnly',
                planMode: false,
            });
            const starts = await fakeLog('codex', 'turn-starts.jsonl');
            expect(starts.map((start) => start.collaborationMode)).toEqual([
                expect.objectContaining({ mode: 'plan' }),
                expect.objectContaining({ mode: 'default' }),
            ]);

            // The same plan cannot start a second turn.
            await expect(service.implementPlan(terminal.id, planId)).rejects.toMatchObject({
                code: 'CONFLICT',
            });
            expect(service.read(terminal.id).turns).toHaveLength(2);
        });

        it('refuses a plan that is not the latest, was left by hand, or follows a new message', async () => {
            const { planId, service, terminal, until } = await proposePlan();

            await expect(service.implementPlan(terminal.id, 'other-item')).rejects.toMatchObject({
                code: 'CONFLICT',
            });

            await service.send(terminal.id, { text: 'one more thing' });
            await until(
                (current) =>
                    current.turns.length === 2 && current.turns.at(-1)?.status === 'completed',
            );
            await expect(service.implementPlan(terminal.id, planId)).rejects.toMatchObject({
                code: 'CONFLICT',
            });
        });

        it('refuses once plan mode was turned off by hand', async () => {
            const { planId, service, terminal, until } = await proposePlan();
            await service.setPermission(terminal.id, { planMode: false });
            await until((current) => current.planMode === false);
            await expect(service.implementPlan(terminal.id, planId)).rejects.toMatchObject({
                code: 'CONFLICT',
            });
        });
    });

    it('shows a launch configuration no level matches as no level', async () => {
        const { until } = await fixture({ launchArgs: ['--ask-for-approval', 'untrusted'] });
        const snapshot = await until((current) => current.models !== undefined);
        expect(snapshot.permissionMode).toBeUndefined();
        expect(snapshot.planMode).toBe(false);
    });
});

describe('Agent Chat permission level and plan mode with a fake Claude Code CLI', () => {
    it('switches in place and returns to the chosen level after an approved plan', async () => {
        const { database, fakeLog, service, terminal, until } = await fixture({
            provider: 'claude',
        });
        expect(await until((snapshot) => snapshot.models !== undefined)).toMatchObject({
            permissionMode: 'ask',
            planMode: false,
        });

        await service.setPermission(terminal.id, { permissionMode: 'acceptEdits' });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        // The turn's init reports the mode Claude Code now runs with, and it agrees.
        expect(service.read(terminal.id)).toMatchObject({
            permissionMode: 'acceptEdits',
            planMode: false,
        });

        await service.setPermission(terminal.id, { planMode: true });
        await until((snapshot) => snapshot.planMode === true);
        await service.send(terminal.id, { text: 'planmode' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'accept',
        });
        await until(
            (snapshot) =>
                snapshot.turns.at(-1)?.status === 'completed' && snapshot.turns.length === 2,
        );
        const after = await until((snapshot) => snapshot.planMode === false);
        expect(after.permissionMode).toBe('acceptEdits');
        // The approval itself switches to the chosen level, so no tool call runs in a mode Claude Code picked.
        expect(await fakeLog('claude', 'permission-modes.jsonl')).toEqual([
            { mode: 'acceptEdits' },
            { mode: 'plan' },
            { mode: 'acceptEdits' },
        ]);
        expect(database.getChatPermission(terminal.id)).toEqual({
            permissionMode: 'acceptEdits',
            planMode: false,
        });

        // The next turn runs at the chosen level again, not the mode Claude Code picked after the plan.
        await service.send(terminal.id, { text: 'again' });
        await until(
            (snapshot) =>
                snapshot.turns.length === 3 && snapshot.turns.at(-1)?.status === 'completed',
        );
        expect(service.read(terminal.id)).toMatchObject({
            permissionMode: 'acceptEdits',
            planMode: false,
        });
    });

    it('leaves an inherited level unstored when an approved plan ends plan mode', async () => {
        const { database, service, terminal, until } = await fixture({ provider: 'claude' });
        await until((snapshot) => snapshot.models !== undefined);
        await service.setPermission(terminal.id, { planMode: true });
        await until((snapshot) => snapshot.planMode === true);
        await service.send(terminal.id, { text: 'planmode' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'accept',
        });
        await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.planMode,
        );
        expect(database.getChatPermission(terminal.id)).toEqual({ planMode: false });
    });

    it('launches with the saved level and offers no read-only level', async () => {
        const { database, service, terminal, until } = await fixture({ provider: 'claude' });
        database.setChatPermission(terminal.id, { permissionMode: 'fullAccess', planMode: false });
        await until((snapshot) => snapshot.permissionMode === 'fullAccess');
        await expect(
            service.setPermission(terminal.id, { permissionMode: 'readOnly' }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
});

describe('Agent Chat permission level with a fake Grok Build agent', () => {
    it('restarts on the same conversation to apply a level and has no plan mode', async () => {
        const { service, sessionOpens, terminal, until } = await fixture({ provider: 'grok' });
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.permissionMode).toBe('ask');
        expect(ready.planMode).toBeUndefined();
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');

        await service.setPermission(terminal.id, { permissionMode: 'fullAccess' });
        await until(
            (snapshot) => snapshot.status === 'ready' && snapshot.permissionMode === 'fullAccess',
        );
        const opens = await sessionOpens();
        expect(opens.at(-1)?.method).toBe('session/load');
        expect(opens.at(-1)?.args).toContain('--always-approve');

        await service.setPermission(terminal.id, { permissionMode: 'auto' });
        await until(
            (snapshot) => snapshot.status === 'ready' && snapshot.permissionMode === 'auto',
        );
        const arguments_ = (await sessionOpens()).at(-1)?.args ?? [];
        expect(arguments_).not.toContain('--always-approve');
        expect(arguments_.slice(0, arguments_.indexOf('agent'))).toEqual([
            '--permission-mode',
            'auto',
        ]);

        await expect(service.setPermission(terminal.id, { planMode: true })).rejects.toMatchObject({
            code: 'VALIDATION',
        });
    });

    it('delivers a message sent right after a switch to the restarted agent', async () => {
        const { service, sessionOpens, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');

        // The Client does not wait for the switch before sending.
        await Promise.all([
            service.setPermission(terminal.id, { permissionMode: 'fullAccess' }),
            service.send(terminal.id, { text: 'slow' }),
        ]);
        // A long turn: one that reached the old process would be cut short by the restart and lost from its record.
        const running = await until(
            (snapshot) =>
                snapshot.status === 'ready' &&
                snapshot.permissionMode === 'fullAccess' &&
                snapshot.turns.length === 2 &&
                snapshot.items.filter((item) => item.type === 'agentMessage').length === 2,
        );
        expect(running.turns.map((turn) => turn.status)).toEqual(['completed', 'running']);
        const opens = await sessionOpens();
        expect(opens).toHaveLength(2);
        expect(opens.at(-1)?.method).toBe('session/load');
        expect(opens.at(-1)?.args).toContain('--always-approve');
    });

    it('saves a switch on a Chat that is not running and starts it once with the new level', async () => {
        const { database, service, sessionOpens, spawnProcess, terminal, until } = await fixture({
            provider: 'grok',
        });

        await service.setPermission(terminal.id, { permissionMode: 'fullAccess' });
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(database.getChatPermission(terminal.id)).toEqual({
            permissionMode: 'fullAccess',
            planMode: false,
        });

        await until(
            (snapshot) => snapshot.status === 'ready' && snapshot.permissionMode === 'fullAccess',
        );
        expect(spawnProcess).toHaveBeenCalledTimes(1);
        const opens = await sessionOpens();
        expect(opens).toHaveLength(1);
        expect(opens[0]?.args).toContain('--always-approve');
    });
});
