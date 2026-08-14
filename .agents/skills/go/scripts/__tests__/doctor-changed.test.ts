import { describe, expect, it } from 'vitest';

import { createDoctorCommand } from '../../../../../scripts/doctor-changed';

describe('changed-scope React Doctor command', () => {
    it('uses the immutable event base for pull requests and main pushes', () => {
        expect(createDoctorCommand({ CAXRI_REACT_DOCTOR_BASE: 'base-sha' })).toEqual([
            'run',
            'doctor',
            '--',
            '--scope',
            'changed',
            '--base',
            'base-sha',
        ]);
    });

    it('uses origin/main for the exact-head local fallback', () => {
        expect(createDoctorCommand({})).toEqual([
            'run',
            'doctor',
            '--',
            '--scope',
            'changed',
            '--base',
            'origin/main',
        ]);
    });

    it('runs a full scan when an initial push has no previous commit', () => {
        expect(
            createDoctorCommand({
                CAXRI_REACT_DOCTOR_BASE: '0000000000000000000000000000000000000000',
            }),
        ).toEqual(['run', 'doctor']);
    });
});
