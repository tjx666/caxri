import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Codex Chat skills with a fake app-server', () => {
    it('reads the skills the running app-server reports, plugin skills and disabled flags included', async () => {
        const { service, terminal, until } = await fixture({ codexSkills: true });
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => !snapshot.activeTurnId && snapshot.items.length > 0);
        const skills = await service.readSkills(terminal.id);
        expect(
            skills?.map(({ name, enabled, isProject }) => ({ name, enabled, isProject })),
        ).toEqual([
            { name: 'repo-helper', enabled: true, isProject: true },
            { name: 'imagegen', enabled: true, isProject: false },
            { name: 'github:triage-issue', enabled: true, isProject: false },
            { name: 'linear:plan', enabled: false, isProject: false },
        ]);
    });

    it('reports nothing before the Chat has a running process, so listing never starts one', async () => {
        const { service, terminal } = await fixture();
        await expect(service.readSkills(terminal.id)).resolves.toBeUndefined();
    });

    it('rejects when the app-server has no skills/list, leaving the caller on the scan', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'hello' });
        await until((snapshot) => !snapshot.activeTurnId && snapshot.items.length > 0);
        await expect(service.readSkills(terminal.id)).rejects.toThrow();
    });
});
