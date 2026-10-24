import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
    BARCODE_VECTOR_PNG_BASE64,
    BARCODE_VECTOR_TEXT,
    verifyBarcodeVector,
} from './barcode-vector';

describe('barcode vector', () => {
    it('encodes text as long as a five-address pairing link', () => {
        expect(BARCODE_VECTOR_TEXT).toHaveLength(294);
        expect(BARCODE_VECTOR_TEXT.startsWith('caxri://acceptance/barcode?')).toBe(true);
    });

    it('ships a PNG image', () => {
        expect(Buffer.from(BARCODE_VECTOR_PNG_BASE64, 'base64').subarray(1, 4).toString()).toBe(
            'PNG',
        );
    });

    it('passes only when the decoder returns the encoded text', () => {
        expect(verifyBarcodeVector([BARCODE_VECTOR_TEXT])).toBe('passed');
        expect(verifyBarcodeVector([])).toBe('failed');
        expect(verifyBarcodeVector([BARCODE_VECTOR_TEXT.slice(0, -1)])).toBe('failed');
    });
});
