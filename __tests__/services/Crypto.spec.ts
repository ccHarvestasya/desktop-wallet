/*
 * (C) Symbol Contributors 2021
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { Crypto } from 'symbol-sdk/dist/src/core/crypto/Crypto';

const PASSWORD = 'correct horse battery staple';
const PLAINTEXT = 'symbol wallet legacy fixture';

// Generated independently from the SDK implementation with fixed salt and IV.
const CIPHERTEXT = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100vA14xcWEcIkXraiAlMGnxi8xhFImEYvJsTJMJMlXQqc=';

// The encrypted payload has one byte removed from the fixed ciphertext.
const TRUNCATED_CIPHERTEXT = '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100vA14xcWEcIkXraiAlMGnxi8xhFImEYvJsTJMJMlXQg==';

// The first IV nibble is changed. CBC decryption currently returns the resulting plaintext.
const MODIFIED_IV_CIPHERTEXT =
    '00112233445566778899aabbccddeeffafeeddccbbaa99887766554433221100vA14xcWEcIkXraiAlMGnxi8xhFImEYvJsTJMJMlXQqc=';

// These malformed headers and payloads record the SDK's current parsing behavior.
const SHORT_SALT_CIPHERTEXT = CIPHERTEXT.slice(2);
const SHORT_IV_CIPHERTEXT = CIPHERTEXT.slice(0, 32) + CIPHERTEXT.slice(34);
const NON_HEX_SALT_CIPHERTEXT = 'zz' + CIPHERTEXT.slice(2);
const NON_HEX_IV_CIPHERTEXT = CIPHERTEXT.slice(0, 32) + 'zz' + CIPHERTEXT.slice(34);
const INVALID_BASE64_CIPHERTEXT = CIPHERTEXT.slice(0, 64) + '@@@=';
const HEADER_TRUNCATED_CIPHERTEXT = CIPHERTEXT.slice(0, 63) + CIPHERTEXT.slice(64);

// The last ciphertext byte differs from the fixed vector by one bit.
const ONE_BIT_CHANGED_CIPHERTEXT =
    '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100vA14xcWEcIkXraiAlMGnxi8xhFImEYvJsTJMJMlXQqM=';

describe('symbol-sdk Crypto legacy format', () => {
    test('decrypts a fixed SDK 2.0.6 ciphertext', () => {
        expect(Crypto.decrypt(CIPHERTEXT, PASSWORD)).toBe(PLAINTEXT);
    });

    test('uses a 16-byte hexadecimal salt, a 16-byte hexadecimal IV, and base64 ciphertext', () => {
        const salt = CIPHERTEXT.slice(0, 32);
        const iv = CIPHERTEXT.slice(32, 64);
        const encrypted = CIPHERTEXT.slice(64);
        const encryptedBytes = Buffer.from(encrypted, 'base64');

        expect(CIPHERTEXT.length).toBe(108);
        expect(salt).toMatch(/^[0-9a-f]{32}$/);
        expect(iv).toMatch(/^[0-9a-f]{32}$/);
        expect(encrypted).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(encryptedBytes.length).toBeGreaterThan(0);
        expect(encryptedBytes.length % 16).toBe(0);
    });

    test('observes empty-string results for an incorrect password and empty inputs in the fixed fixture', () => {
        expect(Crypto.decrypt(CIPHERTEXT, 'wrong password')).toBe('');
        expect(Crypto.decrypt(CIPHERTEXT, '')).toBe('');
        expect(Crypto.decrypt('', PASSWORD)).toBe('');
        expect(Crypto.decrypt('', '')).toBe('');
    });

    test('observes an empty-string result when the fixed encrypted payload is truncated', () => {
        expect(Crypto.decrypt(TRUNCATED_CIPHERTEXT, PASSWORD)).toBe('');
    });

    test('records current parsing behavior for malformed headers and payloads', () => {
        expect(Crypto.decrypt(SHORT_SALT_CIPHERTEXT, PASSWORD)).toBe('');
        expect(Crypto.decrypt(SHORT_IV_CIPHERTEXT, PASSWORD)).toBe('');
        expect(Crypto.decrypt(NON_HEX_SALT_CIPHERTEXT, PASSWORD)).toBe(PLAINTEXT);
        expect(() => Crypto.decrypt(NON_HEX_IV_CIPHERTEXT, PASSWORD)).toThrow('Malformed UTF-8 data');
        expect(Crypto.decrypt(INVALID_BASE64_CIPHERTEXT, PASSWORD)).toBe('');
        expect(Crypto.decrypt(HEADER_TRUNCATED_CIPHERTEXT, PASSWORD)).toBe('');
    });

    test('records the current CBC behavior for a modified IV', () => {
        // This is a compatibility characterization, not an integrity guarantee.
        expect(Crypto.decrypt(MODIFIED_IV_CIPHERTEXT, PASSWORD)).toBe('#ymbol wallet legacy fixture');
    });

    test('records the current CBC behavior for a one-bit ciphertext change', () => {
        // This is a compatibility characterization, not an integrity guarantee.
        expect(Crypto.decrypt(ONE_BIT_CHANGED_CIPHERTEXT, PASSWORD)).toBe('symbol wallet');
    });
});
