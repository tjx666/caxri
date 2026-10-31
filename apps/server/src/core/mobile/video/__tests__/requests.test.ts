// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import { Buffer } from 'node:buffer';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentChatItem, MobileDeviceRole, Principal } from '@caxri/protocol';
import { CaxriError, parseCaxriRequest } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../../domain-service';
import { isMobileGatewayMethodAllowedForRole } from '../../role-methods';
import { clearMobileCitedVideos } from '../cited-video';
import { createMobileVideoRequests } from '../requests';

const principalFor = (role: MobileDeviceRole): Extract<Principal, { kind: 'paired-device' }> => ({
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role,
    projectIds: ['project-1'],
});
const principal = principalFor('view');

const fixture = { directory: '', video: '' };

beforeEach(async () => {
    clearMobileCitedVideos();
    const directory = await mkdtemp(path.join(tmpdir(), 'caxri-mobile-video-'));
    fixture.directory = await realpath(directory);
    fixture.video = path.join(fixture.directory, 'demo.mp4');
    await writeFile(fixture.video, '0123456789');
});

afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
});

const userMessage = (id: string, text: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text,
});

function domain(options: { granted?: boolean; items?: () => AgentChatItem[] } = {}) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'terminal.queryForPrincipal')
                return {
                    terminals:
                        options.granted === false
                            ? []
                            : [{ id: 'terminal-1', sessionId: 'session-1', surface: 'chat' }],
                };
            if (method === 'agentChat.read')
                return {
                    terminalId: 'terminal-1',
                    revision: 1,
                    status: 'ready',
                    truncated: false,
                    items: options.items?.() ?? [
                        userMessage(
                            'item-1',
                            `# Files mentioned by the user:\n\n## demo.mp4: ${fixture.video}\n\n## My request:\nwhy`,
                        ),
                    ],
                    turns: [],
                    requests: [],
                };
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

const run = vi.fn(async (file: string, arguments_: readonly string[]) => {
    if (file === 'qlmanage') {
        const directory = arguments_[arguments_.indexOf('-o') + 1];
        const name = `${path.basename(arguments_.at(-1)!)}.png`;
        await writeFile(path.join(directory, name), 'PNG');
    } else await writeFile(arguments_.at(-1)!, 'JPEG');
});

function requests() {
    return createMobileVideoRequests({
        platform: 'darwin',
        random: (bytes) => new Uint8Array(bytes).fill(7),
        registry: { currentPrincipal: () => principal },
        run,
    });
}

const target = (overrides: { path?: string; itemId?: string } = {}) => ({
    terminalId: 'terminal-1',
    itemId: overrides.itemId ?? 'item-1',
    path: overrides.path ?? fixture.video,
});

const read = (
    video: ReturnType<typeof requests>,
    service: ReturnType<typeof domain>,
    parameters = target(),
    as = principal,
) =>
    video.invoke(
        parseCaxriRequest('mobile.video.read', parameters) as never,
        as,
        service.domainService,
        () => '127.0.0.1',
        () => {},
    );

describe('mobile video requests', () => {
    it('lets every paired role show and play a cited video', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            for (const method of ['mobile.video.read', 'mobile.video.open'])
                expect(isMobileGatewayMethodAllowedForRole(role, method)).toBe(true);
    });

    it.each(['view', 'reply', 'control'] as const)(
        'serves a %s device the poster of a video its message cites',
        async (role) => {
            const video = requests();
            await expect(read(video, domain(), target(), principalFor(role))).resolves.toEqual({
                poster: {
                    mediaType: 'image/jpeg',
                    data: Buffer.from('JPEG').toString('base64'),
                    chunkIndex: 0,
                    chunkCount: 1,
                },
            });
            await video.clear();
        },
    );

    it('refuses a Chat outside the granted Projects', async () => {
        await expect(read(requests(), domain({ granted: false }))).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('refuses a path the message does not cite, even another video', async () => {
        const other = path.join(fixture.directory, 'other.mp4');
        await writeFile(other, 'x');
        const targets = [
            target({ path: other }),
            target({ path: path.join(fixture.directory, 'notes.md') }),
            target({ itemId: 'item-missing' }),
        ];
        await Promise.all(
            targets.map((parameters) =>
                expect(read(requests(), domain(), parameters)).rejects.toMatchObject({
                    code: 'NOT_FOUND',
                }),
            ),
        );
    });

    it('reads a deleted video, or a link to a file that is not a video, as unavailable', async () => {
        await rm(fixture.video);
        await expect(read(requests(), domain())).resolves.toBeNull();
        await writeFile(path.join(fixture.directory, 'secret.txt'), 'secret');
        await symlink(path.join(fixture.directory, 'secret.txt'), fixture.video);
        clearMobileCitedVideos();
        await expect(read(requests(), domain())).resolves.toBeNull();
    });

    it('opens a URL on the address the phone reached, and none over the Relay', async () => {
        const video = requests();
        const service = domain();
        const opened = await video.invoke(
            parseCaxriRequest('mobile.video.open', target()) as never,
            principal,
            service.domainService,
            () => '127.0.0.1',
            () => {},
        );
        expect(opened).toEqual({
            url: expect.stringMatching(
                /^http:\/\/127\.0\.0\.1:\d+\/mobile\/video\/(07){32}$/u,
            ) as string,
        });
        const overRelay = video.invoke(
            parseCaxriRequest('mobile.video.open', target()) as never,
            principal,
            service.domainService,
            () => {
                throw new CaxriError('UNAVAILABLE', 'Not available over the Relay route');
            },
            () => {},
        );
        await expect(overRelay).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await video.clear();
    });

    it('finds an older message through history paging', async () => {
        const service = domain({ items: () => [userMessage('item-9', 'newest')] });
        service.request.mockImplementation(async (method) => {
            if (method === 'terminal.queryForPrincipal')
                return {
                    terminals: [{ id: 'terminal-1', sessionId: 'session-1', surface: 'chat' }],
                };
            if (method === 'agentChat.read')
                return {
                    terminalId: 'terminal-1',
                    revision: 1,
                    status: 'ready',
                    truncated: true,
                    items: [userMessage('item-9', 'newest')],
                    turns: [],
                    requests: [],
                };
            if (method === 'agentChat.readHistory')
                return {
                    historyId: 'history',
                    items: [userMessage('item-1', `look at ${fixture.video}`)],
                    turns: [],
                    hasMore: false,
                    truncated: false,
                };
            throw new Error(`Unexpected ${method}`);
        });
        await expect(read(requests(), service)).resolves.toMatchObject({
            poster: { mediaType: 'image/jpeg' },
        });
    });
});
