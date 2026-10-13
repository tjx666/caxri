import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('MCP server identity in a Codex Chat with a fake app-server', () => {
    it('publishes the icon of a server the turn called', async () => {
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'explore' });
        const done = await until(
            (snapshot) => !snapshot.activeTurnId && snapshot.mcpServers !== undefined,
        );
        expect(done.mcpServers?.map(({ name, title }) => ({ name, title }))).toEqual([
            { name: 'docs', title: 'Docs' },
        ]);
        expect(done.mcpServers?.[0]?.icons?.map((icon) => icon.src)).toEqual([
            expect.stringMatching(/^data:image\/svg\+xml;base64,/u) as string,
        ]);
    });
});
