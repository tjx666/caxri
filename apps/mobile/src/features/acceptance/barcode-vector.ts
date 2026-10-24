export const BARCODE_VECTOR_ID = 'caxri-mobile-barcode-v1';

const BARCODE_VECTOR_PREFIX = 'caxri://acceptance/barcode?vector=v1&padding=';

/**
 * The text the vector encodes. It is padded to the length of a pairing link that carries five addresses (294
 * characters), so the decoder has to read a symbol as dense as the code Desktop shows, without any credential in it.
 */
export const BARCODE_VECTOR_TEXT = BARCODE_VECTOR_PREFIX.padEnd(294, '0123456789');

/**
 * A 1-bit PNG of {@link BARCODE_VECTOR_TEXT}: a 69x69-module QR code at error-correction level M, 4px per module, with a
 * four-module quiet zone.
 */
export const BARCODE_VECTOR_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAATQAAAE0AQAAAACK+vIyAAAD90lEQVR42u2aMY5kRwxD3zec899g73+svsGrE9CBqo2NjHWkDbbR6MEAFQgqSaTIesqvfM5f/Nrnz7k/5/7nued5Xt7zngeeh8PDed/nvIf3PO/zPO9efLRpo4mxaWKItvPbtKmb8ZEkAoXWJg3YBtKQ3yC+FiFpsDe4Gpvd+O658x4BPufT90nz8MnJ+fEu98etv7Q1yfwPlIg2y/X3lAfyX9AB8Szmr22nNUiRNA3QVJK2Xe4PUrCWueNobGy0kN34bMRoarW1JrS9IbI8X9KYaNUAAX8agav5+xv4PH36AnkwcMh73g95wqHv8nyRYm160zb5K4qo6/hGy8UPrLSiaWnSLtffzBViFEKGGUCsyvp8SRsCNtTa+m0OScPyfIkUSCS9IHdHzNTfbnygTbBVtbaZ+YyNuj3/RFua0kIoTYQ6c3q3P6j+G1iiWKHBZJBkNT5JBz0goTNSiq3ULvcHYmucTBY1aDq3zvL8MyTFqBXunQaGOHS9fzP3GDNI55RhQ36D/IXEIfRNM+nTwbregb3aHzEaqMV6+V80ii7vl5ZgnM3X2Y3utZes469UJHQuWNNEHaQT1ufz6BnVNBTQJMyI2cZf02pJWnMDCjd/6bb+AiSAWjJhYQZUZs/cjS+VMNeZ1Nl/Z69Ls87/JoPtaBpDnL8rsHcEbepDT5qP70tJfrwpvLz5MHHzbutDCUqkSDPknmKbZFs/SDMcGqB4MTeDvGnW+wPohOVVspzNI/UKRav8z6pC09H8huz3zr9t/mdiQ3JxQ6MqtiOvresHUDFXwmJmTAPCOr/vUL5g6KV9V/QdUr3MD0YjVaVoBjqmAB1avctPBzWI43d49fGMdLWunzoyVRIlo+BP3QljjizrQxiRlNz9fDTzTKzL+ilPn4xO2se8JAfIyTnh8Y0s7786MKugw/MJQ7fW+fM0heaCWjIWJrmXvq3/ZTCX61zGq/9dpr/NX7SR0sCM4+vPgLieP0YrHWZlOk7N2EhtWddfxvIdteUrUQ45vRRw17/syyEcgR+AvJ/wHuQHp08X37/Qfi2PxKB6qVaHK7Bdf9EvnDk0pl7/Y5TVff+yI13NcsmUoG3IyEXL/E8aYzJ6uHzN3zSu72+EcbHmrh1a4Pe7X39hUpiv2Ox1fk1x3V/ItSuHZHUktq/+bNb104Ffm+9OyTheYHs3JZffb6TTqUXT3P6d3Tzs638z7wjIkKtrY5J9fn+fYI0/aEZ/qV/94Hd4Hzbm7/iWV/+bvSPL9ff3/Xt6cvLkfCAvHOh5OYU3y/rfd2kzI/DGKcteiv8b1F/7kxFyK6+Nd0fa1+8noHnrOUNmnpjMw6JVfsqf99l/zm2d+wfvWmm47zKAOQAAAABJRU5ErkJggg==';

export type BarcodeVectorStatus = 'failed' | 'passed';

/**
 * Passes only when the decoder returned exactly the encoded text, so a decoder that silently returns nothing fails.
 */
export const verifyBarcodeVector = (decoded: readonly string[]): BarcodeVectorStatus =>
    decoded.includes(BARCODE_VECTOR_TEXT) ? 'passed' : 'failed';
