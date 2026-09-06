/**
 * Copyright 2023-present DreamNum Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';
import {
    computeVisualOrderForItems,
    containsRTL,
    detectTextDirection,
    processTextForDraw,
    resolveBidi,
    shapeArabic,
} from '../rtl-processor';

describe('rtl-processor: detection', () => {
    it('detects RTL characters in base and presentation ranges', () => {
        expect(containsRTL('مرحبا')).toBe(true);
        expect(containsRTL('\uFE8D\uFE8E')).toBe(true); // presentation forms-B
        expect(containsRTL('עברית')).toBe(true); // Hebrew
        expect(containsRTL('hello')).toBe(false);
        expect(containsRTL('123')).toBe(false);
        expect(containsRTL('')).toBe(false);
    });

    it('detects paragraph direction from the first strong character', () => {
        expect(detectTextDirection('مرحبا')).toBe('rtl');
        expect(detectTextDirection('hello')).toBe('ltr');
        expect(detectTextDirection('123 مرحبا')).toBe('rtl'); // neutrals skipped
        expect(detectTextDirection('hello مرحبا')).toBe('ltr');
        expect(detectTextDirection(' مرحبا hello')).toBe('rtl');
        expect(detectTextDirection(' 123 ')).toBe('ltr'); // fallback
        expect(detectTextDirection('', 'rtl')).toBe('rtl');
    });
});

describe('rtl-processor: bidi reordering', () => {
    it('reorders a pure Arabic sentence so the first word paints rightmost', () => {
        // "اب ج": visual (LTR paint order) must show the LAST word first.
        const { visual, direction } = resolveBidi('اب ج');

        expect(direction).toBe('rtl');
        expect(visual).toBe('ج با');
    });

    it('matches the classic bismillah word-order expectation', () => {
        // "بسم الله": first word must end up on the RIGHT side of the line.
        const { visual } = resolveBidi('بسم الله');
        const visualWords = visual.split(' ');

        expect(visualWords[visualWords.length - 1]).toBe([...('بسم')].reverse().join(''));
        expect(visualWords[0]).toBe([...('الله')].reverse().join(''));
    });

    it('keeps European numbers left-to-right inside an RTL sentence', () => {
        const { visual } = resolveBidi('عربي 123');

        expect(visual).toBe('123 يبرع');
        expect(visual.startsWith('123')).toBe(true);
    });

    it('keeps decimal numbers intact inside an RTL sentence (rule W4)', () => {
        const { visual } = resolveBidi('عربي 1.23');

        expect(visual.startsWith('1.23')).toBe(true);
    });

    it('keeps times intact inside an RTL sentence (rule W4)', () => {
        const { visual } = resolveBidi('اجتماع 12:30');

        expect(visual.startsWith('12:30')).toBe(true);
    });

    it('mirrors paired punctuation on RTL runs (rule L4)', () => {
        const { visual } = resolveBidi('(مرحبا)');

        // The Arabic word is visually reversed, the parentheses are mirrored
        // so the opening one still faces the text.
        expect(visual).toBe(`(${[...('مرحبا')].reverse().join('')})`);
    });

    it('keeps LTR text untouched', () => {
        const { visual, direction, map } = resolveBidi('hello world');

        expect(direction).toBe('ltr');
        expect(visual).toBe('hello world');
        expect(map).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('places an embedded Arabic word correctly in an LTR line', () => {
        const { visual } = resolveBidi('hello مرحبا', 'ltr');

        // Base LTR: "hello" first, the Arabic word stays in place (its
        // internal code points are visually reversed).
        expect(visual.startsWith('hello ')).toBe(true);
        expect(visual.endsWith([...('مرحبا')].reverse().join(''))).toBe(true);
    });
});

describe('rtl-processor: arabic shaping', () => {
    it('shapes joining letters into presentation forms', () => {
        // سلام contains the mandatory lam-alef ligature: seen-initial +
        // lam-alef (connected) + meem-isolated.
        const { text, shaped } = shapeArabic('سلام');

        expect(shaped).toBe(true);
        expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual([
            'feb3',
            'fefa',
            'fee1',
        ]);
    });

    it('shapes a word without lam-alef into initial/medial/final chain', () => {
        // مدرسة: meem-initial + dal-final + reh-isolated + seen-initial +
        // teh-marbuta-final (reh never joins forward).
        const { text } = shapeArabic('مدرسة');

        expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual([
            'fee3',
            'feaa',
            'fead',
            'feb3',
            'fe94',
        ]);
    });

    it('produces initial/medial/final chains', () => {
        // كتب: kaf-initial + teh-medial + beh-final
        const { text } = shapeArabic('كتب');

        expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual([
            'fedb',
            'fe98',
            'fe90',
        ]);
    });

    it('builds the mandatory lam-alef ligature', () => {
        const { text } = shapeArabic('لا');

        expect(text.codePointAt(0)!.toString(16)).toBe('fef9');
    });

    it('builds the connected lam-alef ligature after a joining letter', () => {
        // سلا: seen connects forward into the lam-alef ligature.
        const { text } = shapeArabic('سلا');

        expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual([
            'feb3',
            'fefa',
        ]);
    });

    it('honours zero-width non-joiner', () => {
        const { text } = shapeArabic('ب\u200Cا');

        expect([...text].map((char) => char.codePointAt(0)!.toString(16))).toEqual([
            'fe8f', // beh isolated (ZWNJ breaks joining)
            'fe8d', // alef isolated
        ]);
    });

    it('keeps transparent marks and non-Arabic text unchanged', () => {
        const { text, shaped } = shapeArabic('بَ hello');

        expect(shaped).toBe(true);
        expect(text).toBe('\uFE8F\u064E hello');
    });

    it('reports no shaping for LTR-only text', () => {
        const { shaped } = shapeArabic('hello 123');

        expect(shaped).toBe(false);
    });
});

describe('rtl-processor: draw helpers', () => {
    it('uses the platform direction and keeps the logical string when supported', () => {
        const processed = processTextForDraw('مرحبا', true);

        expect(processed.text).toBe('مرحبا');
        expect(processed.direction).toBe('rtl');
    });

    it('falls back to shaped + reordered text without platform direction', () => {
        const processed = processTextForDraw('مرحبا', false);

        // Visual string (shaped then code-point reversed): alef-final,
        // beh-medial, hah-INITIAL (reh is right-joining and never connects
        // forward), reh-final, meem-initial.
        expect(processed.direction).toBe('ltr');
        expect(processed.text).toBe('\uFE8E\uFE92\uFEA3\uFEAE\uFEE3');
    });

    it('leaves LTR text untouched', () => {
        const processed = processTextForDraw('hello', true);

        expect(processed.text).toBe('hello');
        expect(processed.direction).toBe('ltr');
    });
});

describe('rtl-processor: glyph-level reordering', () => {
    it('reverses the word order of an Arabic line', () => {
        const items = [
            { content: 'بسم' },
            { content: ' ' },
            { content: 'الله' },
            { content: ' ' },
            { content: 'الرحمن' },
        ];
        const order = computeVisualOrderForItems(items);

        expect(order).toEqual([4, 3, 2, 1, 0]);
    });

    it('restores LTR digit order inside an RTL line', () => {
        // Digits arrive as one glyph per character (otherHandler).
        const items = [
            { content: 'عربي' },
            { content: '1' },
            { content: '2' },
            { content: '3' },
            { content: 'سلام' },
        ];
        const order = computeVisualOrderForItems(items);

        expect(order).toEqual([4, 1, 2, 3, 0]);
    });

    it('keeps decimal separators attached to their number', () => {
        const items = [
            { content: 'عربي' },
            { content: '1' },
            { content: '.' },
            { content: '2' },
            { content: 'سلام' },
        ];
        const order = computeVisualOrderForItems(items);

        expect(order).toEqual([4, 1, 2, 3, 0]);
    });

    it('keeps logical order for LTR-only divides', () => {
        const items = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];

        expect(computeVisualOrderForItems(items)).toEqual([0, 1, 2]);
    });

    it('keeps a single item untouched', () => {
        expect(computeVisualOrderForItems([{ content: 'مرحبا' }])).toEqual([0]);
    });

    it('keeps a Latin word intact between Arabic words', () => {
        // otherHandler emits one glyph per character for Latin text.
        const items = [
            { content: 'عربي' },
            { content: ' ' },
            { content: 'h' },
            { content: 'i' },
            { content: ' ' },
            { content: 'سلام' },
        ];
        const order = computeVisualOrderForItems(items);

        // Visual: سلام h i عربي, with "hi" kept in LTR order.
        expect(order).toEqual([5, 4, 2, 3, 1, 0]);
    });
});
