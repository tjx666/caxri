import { describe, expect, it } from 'vitest';

import { createDoctorCommand } from '../doctor-changed';

describe('createDoctorCommand', () => {
    it('scans the changed files against origin/main, including new files not yet committed', () => {
        expect(createDoctorCommand({})).toEqual([
            'run',
            'doctor',
            '--',
            '--scope',
            'changed',
            '--base',
            'origin/main',
            '--include-untracked',
        ]);
    });

    it('uses the requested base', () => {
        expect(createDoctorCommand({ CAXRI_REACT_DOCTOR_BASE: ' abc123 ' })).toContain('abc123');
    });

    it('scans everything for an initial branch push that has no base', () => {
        expect(createDoctorCommand({ CAXRI_REACT_DOCTOR_BASE: '0'.repeat(40) })).toEqual([
            'run',
            'doctor',
        ]);
    });
});
