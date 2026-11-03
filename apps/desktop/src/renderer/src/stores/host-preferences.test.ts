import type { SshEnvironmentState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/caxri', () => ({ caxri: { onEvent: () => () => {}, request: vi.fn() } }));
vi.mock('./toasts', () => ({ tryCommand: vi.fn() }));

import { useEnvironmentStore } from './environment';
import { hostDisplayOf, listedHostIds } from './host-preferences';

const buildBox: SshEnvironmentState = {
    kind: 'ssh',
    destination: 'build-box',
    hostIdentity: 'me@build-box:22',
    phase: 'connected',
    needsUserAction: false,
};

afterEach(() => {
    useEnvironmentStore.setState({ hosts: [] });
});

describe('listedHostIds', () => {
    it('lists connected Hosts first, then remembered Hosts that can be reached again', () => {
        const ids = listedHostIds([buildBox], {
            shouldShowHostNames: false,
            hosts: {
                'local': { name: 'Studio' },
                'me@build-box:22': { destination: 'build-box' },
                'me@gpu-box:22': { destination: 'gpu-box' },
                'me@renamed:22': { name: 'Never connected' },
            },
        });
        expect(ids).toEqual(['me@build-box:22', 'me@gpu-box:22']);
    });
});

describe('hostDisplayOf', () => {
    it('names an SSH Host by its chosen name, else its destination, and keeps the last detected system offline', () => {
        expect(
            hostDisplayOf('me@gpu-box:22', { destination: 'gpu-box', detectedSystem: 'ubuntu' }),
        ).toEqual({ destination: 'gpu-box', name: 'gpu-box', system: 'ubuntu' });
        expect(hostDisplayOf('me@gpu-box:22', { name: 'GPU', destination: 'gpu-box' }).name).toBe(
            'GPU',
        );
    });

    it('prefers the platform a connected Host reports now over the remembered one', () => {
        useEnvironmentStore.setState({
            hosts: [
                {
                    ...buildBox,
                    platform: { system: 'linux', distribution: 'debian' },
                } as SshEnvironmentState,
            ],
        });
        expect(hostDisplayOf('me@build-box:22', { detectedSystem: 'ubuntu' }).system).toBe(
            'debian',
        );
    });

    it('shows this Mac with the macOS logo unless an icon was chosen', () => {
        expect(hostDisplayOf(undefined, undefined).system).toBe('macos');
        expect(hostDisplayOf(undefined, { icon: { name: 'house' } }).icon).toEqual({
            name: 'house',
        });
    });
});
