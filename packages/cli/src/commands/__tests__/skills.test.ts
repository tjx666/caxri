import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { SKILL_COMMANDS } from '../skills';

function commandFor(path: string[]) {
    const command = SKILL_COMMANDS.find((candidate) => candidate.path.join(' ') === path.join(' '));
    if (!command) throw new Error(`Missing skills command: ${path.join(' ')}`);
    return command;
}

describe('skills get parameter validation', () => {
    const get = commandFor(['skills', 'get']);

    it('accepts the bundled skill name alone', () => {
        expect(get.parseParams(['caxri-cli'])).toEqual({ full: false, name: 'caxri-cli' });
    });

    it('accepts --full as the only trailing option', () => {
        expect(get.parseParams(['caxri-cli', '--full'])).toEqual({
            full: true,
            name: 'caxri-cli',
        });
    });

    it('rejects an unrecognized skill name', () => {
        expect(() => get.parseParams(['other-skill'])).toThrow(
            'Expected the bundled skill name caxri-cli',
        );
    });

    it('rejects an unknown trailing option', () => {
        expect(() => get.parseParams(['caxri-cli', '--bogus'])).toThrow('Unknown option: --bogus');
    });
});

describe('skills list rejects any option', () => {
    const list = commandFor(['skills', 'list']);

    it('accepts no arguments', () => {
        expect(list.parseParams([])).toEqual({});
    });

    it('rejects any positional or option token', () => {
        expect(() => list.parseParams(['--json'])).toThrow(CaxriError);
        expect(() => list.parseParams(['unexpected'])).toThrow('Unexpected argument: unexpected');
    });
});

describe('skills status parameter validation', () => {
    const status = commandFor(['skills', 'status']);

    it('accepts no selection at all', () => {
        expect(status.parseParams([])).toEqual({});
    });

    it('accepts --provider alone', () => {
        expect(status.parseParams(['--provider', 'claude'])).toEqual({ provider: 'claude' });
    });

    it('accepts --local or --global alone', () => {
        expect(status.parseParams(['--local'])).toEqual({ scope: 'local' });
        expect(status.parseParams(['--global'])).toEqual({ scope: 'global' });
    });

    it('accepts --provider together with a scope', () => {
        expect(status.parseParams(['--provider', 'codex', '--global'])).toEqual({
            provider: 'codex',
            scope: 'global',
        });
    });

    it('rejects a duplicate --provider', () => {
        expect(() => status.parseParams(['--provider', 'claude', '--provider', 'codex'])).toThrow(
            '--provider may be provided only once',
        );
    });

    it('rejects choosing both --local and --global', () => {
        expect(() => status.parseParams(['--local', '--global'])).toThrow(
            'Choose at most one of --local or --global',
        );
    });

    it('rejects an unknown option', () => {
        expect(() => status.parseParams(['--bogus'])).toThrow('Unknown option: --bogus');
    });

    it('rejects an invalid --provider value', () => {
        expect(() => status.parseParams(['--provider', 'gemini'])).toThrow(
            '--provider must be claude or codex',
        );
    });
});

describe('skills install/update/uninstall selection parameter validation', () => {
    for (const path of [
        ['skills', 'install'],
        ['skills', 'update'],
        ['skills', 'uninstall'],
    ]) {
        describe(path.join(' '), () => {
            const command = commandFor(path);

            it('accepts an explicit provider with a single scope', () => {
                expect(
                    command.parseParams(['caxri-cli', '--provider', 'claude', '--local']),
                ).toEqual({
                    name: 'caxri-cli',
                    provider: 'claude',
                    scope: 'local',
                });
                expect(
                    command.parseParams(['caxri-cli', '--provider', 'codex', '--global']),
                ).toEqual({
                    name: 'caxri-cli',
                    provider: 'codex',
                    scope: 'global',
                });
            });

            it('rejects a duplicate --provider', () => {
                expect(() =>
                    command.parseParams([
                        'caxri-cli',
                        '--provider',
                        'claude',
                        '--provider',
                        'codex',
                        '--local',
                    ]),
                ).toThrow('--provider may be provided only once');
            });

            it('rejects choosing exactly one of --local or --global when both are given', () => {
                expect(() =>
                    command.parseParams([
                        'caxri-cli',
                        '--provider',
                        'claude',
                        '--local',
                        '--global',
                    ]),
                ).toThrow('Choose exactly one of --local or --global');
            });

            it('requires --provider', () => {
                expect(() => command.parseParams(['caxri-cli', '--local'])).toThrow(
                    'Skill installation requires --provider claude|codex',
                );
            });

            it('requires --local or --global', () => {
                expect(() => command.parseParams(['caxri-cli', '--provider', 'claude'])).toThrow(
                    'Skill installation requires --local or --global',
                );
            });

            it('rejects an unknown option', () => {
                expect(() =>
                    command.parseParams([
                        'caxri-cli',
                        '--provider',
                        'claude',
                        '--local',
                        '--bogus',
                    ]),
                ).toThrow('Unknown option: --bogus');
            });

            it('rejects an invalid --provider value', () => {
                expect(() =>
                    command.parseParams(['caxri-cli', '--provider', 'gemini', '--local']),
                ).toThrow('--provider must be claude or codex');
            });
        });
    }
});
