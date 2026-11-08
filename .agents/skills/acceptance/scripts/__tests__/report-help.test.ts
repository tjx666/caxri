import { describe, expect, it } from 'vitest';

import { parseReportOptions, reportCliHelp, reportOption } from '../report-help';

describe('Acceptance report CLI arguments', () => {
    it('names the finalize options when the round directory is passed positionally', () => {
        expect(() =>
            parseReportOptions('finalize', ['.records/acceptance/example/round-1']),
        ).toThrow(
            /Expected an option, received: \.records\/acceptance\/example\/round-1\nUsage: finalize --dir DIR --requirement TEXT/,
        );
    });

    it('names the command usage when a required option is missing', () => {
        const options = parseReportOptions('finalize', ['--dir', 'round-1']);
        expect(() => reportOption('finalize', options, 'requirement', true)).toThrow(
            /Missing --requirement\nUsage: finalize --dir DIR/,
        );
        expect(reportOption('finalize', options, 'dir', true)).toBe('round-1');
    });

    it('lists every command in the help text', () => {
        const help = reportCliHelp();
        for (const command of ['init', 'rebind-head', 'repair-lifecycle', 'finalize']) {
            expect(help).toContain(`  ${command} --dir DIR`);
        }
    });
});
