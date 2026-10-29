import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    EMPTY_PDF_FIND_RESULT,
    isPdfFindMiss,
    isPdfFindShortcut,
    pdfFindCountLabel,
    pdfFindEvent,
} from '../pdf-find';

const chord = { key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };

describe('pdfFindEvent', () => {
    it('maps each step onto the find controller event type and direction', () => {
        expect(pdfFindEvent('needle', 'query')).toMatchObject({
            type: '',
            query: 'needle',
            findPrevious: false,
            highlightAll: true,
            caseSensitive: false,
        });
        expect(pdfFindEvent('needle', 'next')).toMatchObject({
            type: 'again',
            findPrevious: false,
        });
        expect(pdfFindEvent('needle', 'previous')).toMatchObject({
            type: 'again',
            findPrevious: true,
        });
        expect(pdfFindEvent('needle', 'refresh')).toMatchObject({
            type: 'highlightallchange',
            findPrevious: false,
        });
    });
});

describe('pdfFindCountLabel', () => {
    it('stays empty without a query and while the first results are pending', () => {
        expect(pdfFindCountLabel('', { current: 1, total: 3, isPending: false }, translate)).toBe(
            '',
        );
        expect(
            pdfFindCountLabel('needle', { ...EMPTY_PDF_FIND_RESULT, isPending: true }, translate),
        ).toBe('');
        expect(isPdfFindMiss('needle', { ...EMPTY_PDF_FIND_RESULT, isPending: true })).toBe(false);
    });

    it('shows the current match of the total, and No results once the search settled empty', () => {
        expect(
            pdfFindCountLabel('needle', { current: 2, total: 5, isPending: true }, translate),
        ).toBe('2/5');
        expect(pdfFindCountLabel('needle', EMPTY_PDF_FIND_RESULT, translate)).toBe('No results');
        expect(isPdfFindMiss('needle', EMPTY_PDF_FIND_RESULT)).toBe(true);
        expect(isPdfFindMiss('', EMPTY_PDF_FIND_RESULT)).toBe(false);
    });
});

describe('isPdfFindShortcut', () => {
    it('accepts Cmd+F only', () => {
        expect(isPdfFindShortcut(chord)).toBe(true);
        expect(isPdfFindShortcut({ ...chord, key: 'F' })).toBe(true);
        expect(isPdfFindShortcut({ ...chord, shiftKey: true })).toBe(false);
        expect(isPdfFindShortcut({ ...chord, metaKey: false, ctrlKey: true })).toBe(false);
        expect(isPdfFindShortcut({ ...chord, key: 'g' })).toBe(false);
    });
});
