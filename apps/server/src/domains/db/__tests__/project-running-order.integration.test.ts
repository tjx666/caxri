import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { projectOrderAfterRunningChange } from '../project-running-order';
import { CaxriDatabase } from '../repository';

const directories: string[] = [];
const connections: CaxriDatabase[] = [];
afterEach(async () => {
    for (const connection of connections) connection.close();
    connections.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

describe('projectOrderAfterRunningChange', () => {
    it('appends a newly running Project after the running group', () => {
        expect(
            projectOrderAfterRunningChange(
                ['a', 'b', 'c', 'd'],
                new Set(['a', 'b']),
                new Set(['a', 'b', 'd']),
            ),
        ).toEqual(['a', 'b', 'd', 'c']);
    });

    it('moves the first running Project to the top', () => {
        expect(projectOrderAfterRunningChange(['a', 'b', 'c'], new Set(), new Set(['c']))).toEqual([
            'c',
            'a',
            'b',
        ]);
    });

    it('keeps a running Project in place while it keeps running', () => {
        expect(
            projectOrderAfterRunningChange(
                ['a', 'b', 'c'],
                new Set(['a', 'b']),
                new Set(['a', 'b']),
            ),
        ).toEqual(['a', 'b', 'c']);
    });

    it('drops a stopped Project to the top of the idle group', () => {
        expect(
            projectOrderAfterRunningChange(
                ['a', 'b', 'c', 'd'],
                new Set(['a', 'b', 'c']),
                new Set(['b', 'c']),
            ),
        ).toEqual(['b', 'c', 'a', 'd']);
    });

    it('places a Project that started above one that stopped in the same change', () => {
        expect(
            projectOrderAfterRunningChange(['a', 'b', 'c'], new Set(['a']), new Set(['c'])),
        ).toEqual(['c', 'a', 'b']);
    });
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-running-order-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    connections.push(database);
    const projects = await Promise.all(
        ['a', 'b', 'c'].map(async (name) => {
            const root = join(directory, name);
            await mkdir(root);
            return root;
        }),
    );
    const [a, b, c] = projects.map((root) => database.createProject(root));
    const order = () => database.listVisibleProjects().map((project) => project.id);
    const setAgent = (terminalId: string, status: 'running' | 'completed') =>
        database.updateAgentMetadata(terminalId, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            status,
        });
    return { a, b, c, database, path, order, setAgent };
}

describe('reconcileProjectRunningOrder', () => {
    it('moves Projects as their Agents start and stop, and survives a reopen', async () => {
        const { a, b, c, database, path, order, setAgent } = await fixture();
        const inB = database.createSession(b.id, 'codex').terminal!.id;
        const inC = database.createSession(c.id, 'codex').terminal!.id;
        expect(database.reconcileProjectRunningOrder()).toBeUndefined();

        setAgent(inC, 'running');
        expect(database.reconcileProjectRunningOrder()).toEqual({
            started: [c.id],
            stopped: [],
            running: [c.id],
        });
        expect(order()).toEqual([c.id, a.id, b.id]);

        setAgent(inB, 'running');
        database.reconcileProjectRunningOrder();
        expect(order()).toEqual([c.id, b.id, a.id]);

        // More activity in an already running Project does not move it.
        setAgent(inB, 'running');
        expect(database.reconcileProjectRunningOrder()).toBeUndefined();

        setAgent(inC, 'completed');
        database.reconcileProjectRunningOrder();
        expect(order()).toEqual([b.id, c.id, a.id]);

        connections.splice(connections.indexOf(database), 1);
        database.close();
        const reopened = new CaxriDatabase(path);
        connections.push(reopened);
        expect(reopened.reconcileProjectRunningOrder()).toBeUndefined();
        expect(reopened.listVisibleProjects().map((project) => project.id)).toEqual([
            b.id,
            c.id,
            a.id,
        ]);
    });

    it('drops a Project back when its running Session is archived', async () => {
        const { a, b, database, order, setAgent } = await fixture();
        const created = database.createSession(b.id, 'codex');
        setAgent(created.terminal!.id, 'running');
        database.reconcileProjectRunningOrder();
        expect(order()[0]).toBe(b.id);

        database.archiveSession(created.session.id);
        database.reconcileProjectRunningOrder();
        expect(order().slice(0, 2)).toEqual([b.id, a.id]);
    });

    it('keeps a manual drag until the Project next starts or stops running', async () => {
        const { a, b, c, database, order, setAgent } = await fixture();
        const inA = database.createSession(a.id, 'codex').terminal!.id;
        setAgent(inA, 'running');
        database.reconcileProjectRunningOrder();
        database.reorderProject(a.id, 2);
        expect(order()).toEqual([b.id, c.id, a.id]);

        setAgent(inA, 'running');
        expect(database.reconcileProjectRunningOrder()).toBeUndefined();
        expect(order()).toEqual([b.id, c.id, a.id]);
    });
});
