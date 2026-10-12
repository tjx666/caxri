import { describe, expect, it } from 'vitest';

import { preferredShell, systemShellCandidates } from '../default-shell';

describe('default shell', () => {
    it('never assumes zsh exists on Linux', () => {
        expect(systemShellCandidates('linux')).toEqual(['/bin/bash', '/bin/sh']);
        expect(systemShellCandidates('darwin')[0]).toBe('/bin/zsh');
    });

    it('prefers the inherited SHELL and treats an empty value as unset', () => {
        expect(preferredShell({ SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish');
        expect(preferredShell({ SHELL: '' })).not.toBe('');
    });
});
