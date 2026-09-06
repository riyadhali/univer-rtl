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

/**
 * RTL / Arabic text processor for the canvas render engine.
 *
 * Univer lays out and paints text itself (per glyph or per line) instead of
 * letting the browser lay out whole paragraphs. That breaks right-to-left
 * scripts in two ways:
 *
 *  1. Glyphs (Arabic words) are placed left-to-right in logical order, so an
 *     Arabic sentence such as "بسم الله الرحمن" appears with its words in the
 *     wrong visual order (the last word shows up first, on the left).
 *  2. Whole-line painting has no way to declare a right-to-left base
 *     direction, so mixed content (Arabic + numbers + Latin) resolves
 *     against an implicit LTR base.
 *
 * This module is a self-contained (dependency-free) implementation of the two
 * classic ingredients used by well-known JavaScript text shaping libraries
 * (the approach popularized by `bidi-js` for the Unicode Bidirectional
 * Algorithm, UAX #9, and by `arabic-reshaper` for Arabic presentation forms):
 *
 *  - `resolveBidi`        logical -> visual reordering of a string.
 *  - `shapeArabic`        Arabic joining (presentation forms B + lam-alef).
 *  - `processTextForDraw` combined helper used by whole-line painters that
 *                         falls back to `shape + bidi` when the platform
 *                         `ctx.direction` API is unavailable.
 *  - `computeVisualOrderForItems` the same reordering at glyph granularity,
 *                         used by the document skeleton layout to place
 *                         already-shaped word glyphs at correct positions.
 *                         Digit runs are pre-grouped into atomic LTR blocks
 *                         (W4/W5: "0.03", "76.2", "1,000", "94%" can never
 *                         be scrambled), neutrals are resolved with the
 *                         strong context across glyph boundaries (N1/N2),
 *                         and the result carries L4-mirrored paint contents
 *                         plus the `visual <-> logical` index maps, which
 *                         hit testing and selection rendering consume to map
 *                         a click to the right logical offset and to draw
 *                         carets / selection rectangles on the correct side.
 *  - `computeVisualOrderForGlyphGroup` memoized variant of the above for the
 *                         layout hot path (keyed by glyph segmentation +
 *                         base direction + font style).
 *  - `resolveExplicitBaseDirection` paragraph / section direction resolution
 *                         with priority over content auto-detection.
 */

export type TextDirection = 'ltr' | 'rtl';

enum BidiCharClass {
    L, // strong left-to-right
    R, // strong right-to-left
    AL, // right-to-left Arabic letter
    EN, // European number
    AN, // Arabic number
    N, // neutral (whitespace, punctuation, symbols, marks, ...)
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Ranges of strong right-to-left characters (Arabic, Hebrew, Thaana, N'Ko,
 * Syriac, Samaritan, Mandaic + their presentation forms + RLM/ALM).
 */
const RTL_RANGES: Array<[number, number]> = [
    [0x0590, 0x05FF], // Hebrew
    [0x0600, 0x06FF], // Arabic
    [0x0700, 0x074F], // Syriac
    [0x0750, 0x077F], // Arabic Supplement
    [0x0780, 0x07BF], // Thaana
    [0x07C0, 0x07FF], // NKo
    [0x0800, 0x083F], // Samaritan
    [0x0840, 0x085F], // Mandaic
    [0x0860, 0x086F], // Syriac Supplement
    [0x0870, 0x088F], // Arabic Extended-B
    [0x08A0, 0x08FF], // Arabic Extended-A
    [0xFB1D, 0xFB4F], // Hebrew presentation forms
    [0xFB50, 0xFDFF], // Arabic presentation forms-A
    [0xFE70, 0xFEFF], // Arabic presentation forms-B
];

/** Fast check: does the text contain any right-to-left character? */
export function containsRTL(text: string): boolean {
    if (!text) {
        return false;
    }

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);

        for (const [start, end] of RTL_RANGES) {
            if (code >= start && code <= end) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Return the paragraph base direction following rule P2/P3 of UAX #9:
 * the direction of the first strong directional character.
 */
export function detectTextDirection(text: string, fallback: TextDirection = 'ltr'): TextDirection {
    const chars = Array.from(text);

    for (const char of chars) {
        const cls = getBidiCharClass(char.codePointAt(0)!);

        if (cls === BidiCharClass.R || cls === BidiCharClass.AL) {
            return 'rtl';
        }
        if (cls === BidiCharClass.L) {
            return 'ltr';
        }
    }

    return fallback;
}

// ---------------------------------------------------------------------------
// Unicode Bidirectional Algorithm (practical subset of UAX #9)
// ---------------------------------------------------------------------------

const NEUTRAL_RANGES: Array<[number, number]> = [
    [0x0000, 0x0020], // controls + space
    [0x0021, 0x002F], // ASCII punctuation
    [0x003A, 0x0040],
    [0x005B, 0x0060],
    [0x007B, 0x007F],
    [0x00A0, 0x00A9],
    [0x00AB, 0x00B1],
    [0x00B4, 0x00B4],
    [0x00B6, 0x00B8],
    [0x00BB, 0x00BF],
    [0x02B9, 0x02FF], // modifier letters / combining marks are neutral for our purposes
    [0x0300, 0x036F], // combining diacritical marks
    [0x0374, 0x0375],
    [0x0385, 0x0386],
    [0x0387, 0x0387],
    [0x15FF, 0x15FF],
    [0x2000, 0x200F], // spaces, ZWSP/ZWNJ/ZWJ, LRM/RLM handled explicitly
    [0x2010, 0x205E],
    [0x206A, 0x2BFF],
    [0x2E00, 0x2E7F],
    [0x3000, 0x303F], // CJK punctuation
    [0xFE20, 0xFE2F],
    [0xFF01, 0xFF0F],
    [0xFF1A, 0xFF20],
    [0xFF3B, 0xFF40],
    [0xFF5B, 0xFF65],
    [0xFFE0, 0xFFEF],
];

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
    for (const [start, end] of ranges) {
        if (code >= start && code <= end) {
            return true;
        }
    }

    return false;
}

function getBidiCharClass(code: number): BidiCharClass {
    // Explicit directional marks.
    if (code === 0x200F || code === 0x061C) {
        return BidiCharClass.R;
    }
    if (code === 0x200E) {
        return BidiCharClass.L;
    }

    const digitClass = getDigitCharClass(code);

    if (digitClass !== null) {
        return digitClass;
    }

    // Right-to-left letters.
    if (inRanges(code, RTL_RANGES)) {
        // Inside the Arabic/Hebrew blocks every character that is not a
        // letter/mark class covered below behaves close enough to R.
        return isArabicLetterCode(code) ? BidiCharClass.AL : BidiCharClass.R;
    }

    // Neutrals.
    if (inRanges(code, NEUTRAL_RANGES)) {
        return BidiCharClass.N;
    }

    // Everything else letter-like is treated as strong LTR, which matches the
    // UAX #9 classes of Latin/Greek/Cyrillic/CJK/Indic/... scripts.
    return BidiCharClass.L;
}

/** Digits and digit-adjacent separators (EN / AN). `null` when not a digit. */
function getDigitCharClass(code: number): BidiCharClass | null {
    if ((code >= 0x0030 && code <= 0x0039) || (code >= 0xFF10 && code <= 0xFF19) || (code >= 0x06F0 && code <= 0x06F9)) {
        return BidiCharClass.EN;
    }

    if ((code >= 0x0660 && code <= 0x0669) || code === 0x06DD || (code >= 0x0600 && code <= 0x0605)) {
        return BidiCharClass.AN;
    }

    // Arabic decimal / thousands separators have Bidi class AN: they belong
    // to the surrounding number block, not to the strong RTL letter side.
    if (code === 0x066B || code === 0x066C) {
        return BidiCharClass.AN;
    }

    // U+060C ARABIC COMMA has Bidi class CS: a neutral separator. Treating it
    // as strong R would split mixed number groups ("1,000") and break N1
    // resolution for spaces around Arabic punctuation in mixed text.
    if (code === 0x060C) {
        return BidiCharClass.N;
    }

    return null;
}

const ARABIC_LETTER_RANGES: Array<[number, number]> = [
    [0x0610, 0x061A], // Arabic signs (marks)
    [0x0620, 0x064A], // core Arabic letters + harakat (NSM inherits AL context)
    [0x066E, 0x066F],
    [0x0670, 0x0670],
    [0x0671, 0x06D3],
    [0x06D5, 0x06D5],
    [0x06FA, 0x06FC],
    [0x06FF, 0x06FF],
    [0x0750, 0x077F], // Arabic Supplement
    [0x08A0, 0x08FF], // Arabic Extended-A
    [0xFB50, 0xFDFF], // presentation forms-A
    [0xFE70, 0xFEFF], // presentation forms-B
];

function isArabicLetterCode(code: number): boolean {
    return inRanges(code, ARABIC_LETTER_RANGES);
}

/** Bidi class of an item (glyph / word), decided by its first strong character. */
function getFirstStrongClass(text: string): BidiCharClass | null {
    for (const char of Array.from(text)) {
        const cls = getBidiCharClass(char.codePointAt(0)!);

        if (cls !== BidiCharClass.N) {
            return cls;
        }
    }

    return null;
}

/** Rule W4 separator characters (CS + ES subset that matters for text). */
const COMMON_SEPARATOR = /[:,.\u060C\u066B\u066C\uFF0C\uFF0E\uFF1A]/;

/**
 * Neutrals that may join an adjacent number block during pre-grouping
 * (rule W4 common separators + rule W5 European terminators). A run of
 * digits separated only by these characters is ONE atomic LTR block:
 * "0.03", "76.2", "12:30", "1,000" and "94%" can never be scrambled,
 * no matter how the layout engine segmented them into glyphs.
 */
const NUMBER_NEUTRAL_RE = /^[.,:/\u060C\u066B\u066C\uFF0C\uFF0E\uFF1A%$\u20AC\u00A3\u00A5\u066A\u066D+\u2212\u00B1-]+$/;

/**
 * Resolve embedding levels for a sequence of classes.
 * Implements a practical subset of rules W2/W4/N1/N2/I1/I2 of UAX #9.
 *
 * `contents` carries the original strings (characters or glyph contents) and
 * enables rule W4: common separators such as "." or ":" between two numbers
 * of the same type take that number type, keeping "1.23" and "12:30"
 * intact inside RTL runs.
 */
function resolveLevels(classes: BidiCharClass[], baseLevel: number, contents?: string[]): number[] {
    applyNumberRules(classes, contents);

    if (contents) {
        mergeLtrTokenSeparators(classes, contents);
    }

    resolveNeutrals(classes, baseLevel);

    return setImplicitLevels(classes, baseLevel);
}

const HYPHEN_RE = /^-+$/;

/**
 * Chromium keeps hyphenated Latin/number tokens ("GLM-5.3-Flash") in ONE
 * unbroken LTR island: a hyphen between a strong L and a number (or between
 * two L) joins the LTR side instead of floating on the RTL base level
 * (verified against Chrome with range measurements). Strict rule N1 would
 * resolve the hyphen to the embedding direction and split the token into
 * scrambled islands, so merge it explicitly.
 */
function mergeLtrTokenSeparators(classes: BidiCharClass[], contents: string[]) {
    const strongAt = (from: number, step: number): BidiCharClass | null => {
        for (let j = from; j >= 0 && j < classes.length; j += step) {
            if (classes[j] !== BidiCharClass.N) {
                return classes[j];
            }
        }

        return null;
    };
    const ltrSide = (cls: BidiCharClass): boolean =>
        cls === BidiCharClass.L || cls === BidiCharClass.EN || cls === BidiCharClass.AN;

    for (let i = 1; i < classes.length - 1; i++) {
        if (classes[i] !== BidiCharClass.N || !HYPHEN_RE.test(contents[i] ?? '')) {
            continue;
        }

        const before = strongAt(i - 1, -1);
        const after = strongAt(i + 1, 1);

        if (before !== null && after !== null && ltrSide(before) && ltrSide(after)) {
            classes[i] = BidiCharClass.L;
        }
    }
}

/**
 * W2: European number becomes Arabic number when the last strong
 * predecessor is an Arabic letter.
 * W4: a single common separator between two numbers of the same type
 * takes that type (keeps "1.23" and "12:30" intact inside RTL runs).
 */
function applyNumberRules(classes: BidiCharClass[], contents?: string[]) {
    let lastStrong = BidiCharClass.L;

    for (let i = 0; i < classes.length; i++) {
        const cls = classes[i];

        if (cls === BidiCharClass.EN) {
            classes[i] = lastStrong === BidiCharClass.AL ? BidiCharClass.AN : cls;
        } else if (cls === BidiCharClass.L || cls === BidiCharClass.R || cls === BidiCharClass.AL) {
            lastStrong = cls;
        }
    }

    if (!contents) {
        return;
    }

    for (let i = 1; i < classes.length - 1; i++) {
        if (classes[i] !== BidiCharClass.N || !COMMON_SEPARATOR.test(contents[i])) {
            continue;
        }

        const previous = classes[i - 1];
        const next = classes[i + 1];

        if (previous === next && (previous === BidiCharClass.EN || previous === BidiCharClass.AN)) {
            classes[i] = previous;
        }
    }
}

/**
 * N1/N2: neutrals take the direction of surrounding text.
 * For neutral resolution EN/AN count as R (per UAX #9 N1).
 */
function resolveNeutrals(classes: BidiCharClass[], baseLevel: number) {
    const strongSide = (cls: BidiCharClass): number => {
        if (cls === BidiCharClass.R || cls === BidiCharClass.AL || cls === BidiCharClass.EN || cls === BidiCharClass.AN) {
            return 1;
        }

        return cls === BidiCharClass.L ? 0 : -1;
    };

    for (let i = 0; i < classes.length; i++) {
        if (classes[i] !== BidiCharClass.N) {
            continue;
        }

        let leftStrong = -1;
        for (let j = i - 1; j >= 0; j--) {
            const side = strongSide(classes[j]);

            if (side >= 0) {
                leftStrong = side;
                break;
            }
        }

        let rightStrong = -1;
        for (let j = i + 1; j < classes.length; j++) {
            const side = strongSide(classes[j]);

            if (side >= 0) {
                rightStrong = side;
                break;
            }
        }

        const resolved = leftStrong === rightStrong ? leftStrong : baseLevel;
        classes[i] = resolved === 1 ? BidiCharClass.R : BidiCharClass.L;
    }
}

/** I1/I2: map the resolved classes to embedding levels. */
function setImplicitLevels(classes: BidiCharClass[], baseLevel: number): number[] {
    const levels = new Array<number>(classes.length);

    for (let i = 0; i < classes.length; i++) {
        const cls = classes[i];

        if (baseLevel === 0) {
            levels[i] = cls === BidiCharClass.L
                ? 0
                : cls === BidiCharClass.EN || cls === BidiCharClass.AN
                    ? 2
                    : 1;
        } else {
            levels[i] = cls === BidiCharClass.R || cls === BidiCharClass.AL
                ? 1
                : 2;
        }
    }

    return levels;
}

/** Rule L2: reverse contiguous sequences from the highest level down to 1. */
function reorderIndexes(levels: number[]): number[] {
    const order = levels.map((_, index) => index);
    let maxLevel = 0;

    for (const level of levels) {
        if (level > maxLevel) {
            maxLevel = level;
        }
    }

    for (let level = maxLevel; level >= 1; level--) {
        let start = -1;

        for (let i = 0; i <= order.length; i++) {
            const atLevel = i < order.length && levels[order[i]] >= level;

            if (atLevel && start < 0) {
                start = i;
            } else if (!atLevel && start >= 0) {
                // Reverse the contiguous slice [start, i).
                for (let a = start, b = i - 1; a < b; a++, b--) {
                    const tmp = order[a];
                    order[a] = order[b];
                    order[b] = tmp;
                }
                start = -1;
            }
        }
    }

    return order;
}

// Bidi mirrored pairs (rule L4) for characters common in text documents.
const MIRRORED: Record<string, string> = {
    '(': ')',
    ')': '(',
    '[': ']',
    ']': '[',
    '{': '}',
    '}': '{',
    '<': '>',
    '>': '<',
    '«': '»',
    '»': '«',
    '‹': '›',
    '›': '‹',
    '⟨': '⟩',
    '⟩': '⟨',
};

export interface IBidiResolution {
    /** Resolved base direction. */
    direction: TextDirection;
    /** Embedding level per code point (order of `Array.from(text)`). */
    levels: number[];
    /** Visual-order string: reordered code points, mirroring applied, not shaped. */
    visual: string;
    /** Visual position -> logical code point index. */
    map: number[];
}

/**
 * Reorder a logical-order string into visual order (left-to-right paint
 * order) using the Unicode Bidirectional Algorithm.
 *
 * The result is safe to pass to `ctx.fillText` when the platform shaper is
 * NOT available (i.e. when `ctx.direction` is unsupported). Note that
 * `resolveBidi` does NOT apply Arabic joining; combine it with `shapeArabic`
 * (see `processTextForDraw`) when the platform cannot shape Arabic text.
 */
export function resolveBidi(text: string, baseDirection?: TextDirection): IBidiResolution {
    const chars = Array.from(text);
    const direction = baseDirection ?? detectTextDirection(text);
    const baseLevel = direction === 'rtl' ? 1 : 0;
    const classes = chars.map((char) => getBidiCharClass(char.codePointAt(0)!));
    const levels = resolveLevels(classes, baseLevel, chars);
    const order = reorderIndexes(levels);

    const visualParts: string[] = [];
    const map: number[] = [];

    for (const logicalIndex of order) {
        const char = chars[logicalIndex];
        // L4: mirror paired characters while they sit on an odd (RTL) level.
        visualParts.push(levels[logicalIndex] % 2 === 1 ? (MIRRORED[char] ?? char) : char);
        map.push(logicalIndex);
    }

    return { direction, levels, visual: visualParts.join(''), map };
}

// ---------------------------------------------------------------------------
// Arabic shaping (joining + presentation forms)
// ---------------------------------------------------------------------------

/** Arabic joining types. */
enum JoiningType {
    Dual, // joins on both sides
    Right, // joins only to the previous letter
    Transparent, // combining mark, ignored while scanning
    NonJoining, // everything else
}

const DUAL_JOINING = new Set<number>([
    0x0626,
    0x0628,
    0x062A,
    0x062B,
    0x062C,
    0x062D,
    0x062E,
    0x0633,
    0x0634,
    0x0635,
    0x0636,
    0x0637,
    0x0638,
    0x0639,
    0x063A,
    0x0640,
    0x0641,
    0x0642,
    0x0643,
    0x0644,
    0x0645,
    0x0646,
    0x0647,
    0x064A,
    // Common extended-Arabic letters with dual joining (Persian/Urdu/...).
    0x067E,
    0x0686,
    0x0698,
    0x06A9,
    0x06AF,
    0x06CC,
    0x06AD,
    0x06B5,
    0x06BB,
    0x06C1,
    0x06C2,
    0x06D2,
    0x06D5,
    0x0679,
    0x0688,
    0x0691,
    0x06BA,
    0x06BE,
    0x06C0,
]);

const RIGHT_JOINING = new Set<number>([
    0x0621,
    0x0622,
    0x0623,
    0x0624,
    0x0625,
    0x0627,
    0x0629,
    0x062F,
    0x0630,
    0x0631,
    0x0632,
    0x0648,
    0x0649,
    0x0671,
    0x0672,
    0x0673,
    0x0675,
    0x0676,
    0x0677,
]);

function getJoiningType(code: number): JoiningType {
    // Transparent: harakat & Arabic combining marks, ZWJ/ZWNJ handled later.
    if (
        (code >= 0x0610 && code <= 0x061A) ||
        (code >= 0x064B && code <= 0x065F) ||
        code === 0x0670 ||
        (code >= 0x06D6 && code <= 0x06DC) ||
        (code >= 0x06DF && code <= 0x06E4) ||
        (code >= 0x06E7 && code <= 0x06E8) ||
        (code >= 0x06EA && code <= 0x06ED) ||
        (code >= 0x08F0 && code <= 0x08F3)
    ) {
        return JoiningType.Transparent;
    }

    if (isArabicLetterCode(code)) {
        if (DUAL_JOINING.has(code)) {
            return JoiningType.Dual;
        }
        if (RIGHT_JOINING.has(code)) {
            return JoiningType.Right;
        }

        // Unknown Arabic letters: assume dual joining (best guess).
        return JoiningType.Dual;
    }

    return JoiningType.NonJoining;
}

/**
 * Presentation Forms-B (and a few Forms-A) mappings:
 * base code -> [isolated, final, initial, medial]. `-1` marks a missing form.
 */
const PRESENTATION_FORMS: Record<number, [number, number, number, number]> = {
    0x0621: [0xFE80, 0xFE80, -1, -1],
    0x0622: [0xFE81, 0xFE82, -1, -1],
    0x0623: [0xFE83, 0xFE84, -1, -1],
    0x0624: [0xFE85, 0xFE86, -1, -1],
    0x0625: [0xFE87, 0xFE88, -1, -1],
    0x0626: [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C],
    0x0627: [0xFE8D, 0xFE8E, -1, -1],
    0x0628: [0xFE8F, 0xFE90, 0xFE91, 0xFE92],
    0x0629: [0xFE93, 0xFE94, -1, -1],
    0x062A: [0xFE95, 0xFE96, 0xFE97, 0xFE98],
    0x062B: [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],
    0x062C: [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
    0x062D: [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4],
    0x062E: [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8],
    0x062F: [0xFEA9, 0xFEAA, -1, -1],
    0x0630: [0xFEAB, 0xFEAC, -1, -1],
    0x0631: [0xFEAD, 0xFEAE, -1, -1],
    0x0632: [0xFEAF, 0xFEB0, -1, -1],
    0x0633: [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4],
    0x0634: [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
    0x0635: [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC],
    0x0636: [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0],
    0x0637: [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4],
    0x0638: [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8],
    0x0639: [0xFEC9, 0xFECA, 0xFECB, 0xFECC],
    0x063A: [0xFECD, 0xFECE, 0xFECF, 0xFED0],
    0x0640: [0x0640, 0x0640, 0x0640, 0x0640], // tatweel
    0x0641: [0xFED1, 0xFED2, 0xFED3, 0xFED4],
    0x0642: [0xFED5, 0xFED6, 0xFED7, 0xFED8],
    0x0643: [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],
    0x0644: [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0],
    0x0645: [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4],
    0x0646: [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
    0x0647: [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC],
    0x0648: [0xFEED, 0xFEEE, -1, -1],
    0x0649: [0xFEEF, 0xFEF0, -1, -1],
    0x064A: [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
    // Persian/Urdu letters with presentation forms in Forms-A.
    0x0679: [0xFB66, 0xFB67, 0xFB68, 0xFB69],
    0x067E: [0xFB56, 0xFB57, 0xFB58, 0xFB59],
    0x0686: [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D],
    0x0688: [0xFB88, 0xFB89, -1, -1],
    0x0691: [0xFB8C, 0xFB8D, -1, -1],
    0x0698: [0xFB8A, 0xFB8B, -1, -1],
    0x06A9: [0xFB8E, 0xFB8F, 0xFB90, 0xFB91],
    0x06AF: [0xFB92, 0xFB93, 0xFB94, 0xFB95],
    0x06AD: [0xFBD3, 0xFBD4, -1, -1],
    0x06BA: [0xFB9E, 0xFB9F, -1, -1],
    0x06BE: [0xFAA0, 0xFAA1, 0xFAA2, 0xFAA3],
    0x06C1: [0xFBA6, 0xFBA7, 0xFBA8, 0xFBA9],
    0x06C2: [0xFBAA, 0xFBAB, -1, -1],
    0x06CC: [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF],
    0x06D2: [0xFBAE, 0xFBAF, -1, -1],
};

/** Mandatory lam-alef ligature forms: [alef base -> isolated, final]. */
const LAM_ALEF: Record<number, [number, number]> = {
    0x0622: [0xFEF5, 0xFEF6],
    0x0623: [0xFEF7, 0xFEF8],
    0x0625: [0xFEFB, 0xFEFC],
    0x0627: [0xFEF9, 0xFEFA],
};

const LAM = 0x0644;
const ZWNJ = 0x200C;
const ZWJ = 0x200D;

export interface IArabicShapingResult {
    /** Shaped text (presentation forms) when shaping was applied. */
    text: string;
    /** logical code point index -> shaped code point index (many-to-one for ligatures). */
    map: number[];
    /** Whether any glyph was actually substituted. */
    shaped: boolean;
}

/**
 * Apply Arabic joining: map base Arabic letters to their isolated / final /
 * initial / medial presentation forms, including mandatory lam-alef
 * ligatures. Non-Arabic characters and letters without Unicode presentation
 * forms are left untouched (they keep working through the platform shaper).
 */
export function shapeArabic(text: string): IArabicShapingResult {
    const chars = Array.from(text);
    const codes = chars.map((char) => char.codePointAt(0)!);
    const out: string[] = [];
    const map: number[] = [];
    let shaped = false;

    for (let i = 0; i < chars.length; i++) {
        const code = codes[i];

        if (code === ZWNJ) {
            // Zero-width non-joiner is dropped from the visual string; it has
            // no glyph and only affects the joining decisions made around it.
            continue;
        }

        const table = PRESENTATION_FORMS[code];

        if (!table) {
            out.push(chars[i]);
            map.push(i);
            continue;
        }

        const joining = getJoiningType(code);

        // Transparent marks are painted as-is.
        if (joining === JoiningType.Transparent) {
            out.push(chars[i]);
            map.push(i);
            continue;
        }

        // --- Mandatory lam-alef ligature ---------------------------------
        if (code === LAM) {
            const ligature = findLamAlefLigature(codes, i);

            if (ligature != null) {
                const { end, leftConnected } = ligature;
                const forms = LAM_ALEF[codes[end]];
                const [isolated, final] = forms;

                out.push(String.fromCodePoint(leftConnected ? final : isolated));
                map.push(i);
                shaped = true;
                i = end;

                continue;
            }
        }

        // --- Regular joining ---------------------------------------------
        const connectedLeft = isConnectedToLeft(codes, i);
        const connectedRight = joining === JoiningType.Dual && isConnectedToRight(codes, i);

        let formCode: number;
        if (connectedLeft && connectedRight && table[3] !== -1) {
            formCode = table[3]; // medial
        } else if (connectedLeft && table[1] !== -1) {
            formCode = table[1]; // final
        } else if (connectedRight && table[2] !== -1) {
            formCode = table[2]; // initial
        } else {
            formCode = table[0]; // isolated
        }

        if (formCode !== code) {
            shaped = true;
        }

        out.push(String.fromCodePoint(formCode));
        map.push(i);
    }

    return { text: out.join(''), map, shaped };
}

function findLamAlefLigature(codes: number[], lamIndex: number): { end: number; leftConnected: boolean } | null {
    let index = lamIndex + 1;

    while (index < codes.length && getJoiningType(codes[index]) === JoiningType.Transparent) {
        index++;
    }

    if (index >= codes.length) {
        return null;
    }

    const next = codes[index];

    if (!LAM_ALEF[next]) {
        return null;
    }

    return { end: index, leftConnected: isConnectedToLeft(codes, lamIndex) };
}

/**
 * Whether the letter at `index` is connected to its LEFT neighbour (i.e. the
 * previous letter joins forward towards this one).
 */
function isConnectedToLeft(codes: number[], index: number): boolean {
    for (let j = index - 1; j >= 0; j--) {
        const code = codes[j];

        if (code === ZWJ) {
            return true;
        }
        if (code === ZWNJ) {
            return false;
        }

        const joining = getJoiningType(code);

        if (joining === JoiningType.Transparent) {
            continue;
        }

        return joining === JoiningType.Dual;
    }

    return false;
}

/**
 * Whether the letter at `index` is connected to its RIGHT neighbour (i.e.
 * this letter joins forward towards the next one). Only dual-joining letters
 * can connect forward; callers already check that.
 */
function isConnectedToRight(codes: number[], index: number): boolean {
    for (let j = index + 1; j < codes.length; j++) {
        const code = codes[j];

        if (code === ZWJ) {
            return true;
        }
        if (code === ZWNJ) {
            return false;
        }

        const joining = getJoiningType(code);

        if (joining === JoiningType.Transparent) {
            continue;
        }

        return joining === JoiningType.Dual || joining === JoiningType.Right;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Canvas draw helpers
// ---------------------------------------------------------------------------

export interface IProcessedDrawText {
    /** String to pass to `ctx.fillText`. */
    text: string;
    /**
     * Preferred canvas `direction` when drawing `text`. When the platform
     * supports `ctx.direction` the original logical string is kept (best
     * shaping fidelity); otherwise the returned text is already shaped and
     * visually reordered and `direction` is `ltr`.
     */
    direction: TextDirection;
}

/**
 * Prepare a whole-line string for one-shot `ctx.fillText` painting.
 *
 * When the canvas context exposes the `direction` attribute (all modern
 * browsers, including OffscreenCanvas) we keep the logical string and let the
 * platform shaper apply bidi + Arabic joining at the highest possible
 * fidelity. When it does not, we fall back to `shapeArabic` + `resolveBidi`
 * and return a visual-order shaped string.
 */
export function processTextForDraw(text: string, supportsDirection: boolean, baseDirection?: TextDirection): IProcessedDrawText {
    if (!containsRTL(text)) {
        return { text, direction: 'ltr' };
    }

    const direction = baseDirection ?? detectTextDirection(text);

    if (supportsDirection) {
        return { text, direction };
    }

    const shaped = shapeArabic(text);
    const bidi = resolveBidi(shaped.text, direction);

    return { text: bidi.visual, direction: 'ltr' };
}

// ---------------------------------------------------------------------------
// Glyph-level reordering (document skeleton layout)
// ---------------------------------------------------------------------------

/**
 * Result of the glyph-level bidi reordering.
 *
 * The document skeleton keeps glyphs in logical (typing) order. Hit testing
 * and selection rendering need to translate between that logical order and
 * the visual (left-to-right paint) order, so both index mappings are
 * returned next to the visual order itself.
 */
export interface IVisualOrderForItems {
    /**
     * Visual paint order: `order[visualPosition] = logicalIndex`.
     * Identical to `visualToLogical`, kept as the primary field for
     * backward compatibility with the previous `number[]` return value.
     */
    order: number[];
    /** `visualToLogical[visualPosition] = logicalIndex` (same array as `order`). */
    visualToLogical: number[];
    /** Inverse permutation: `logicalToVisual[logicalIndex] = visualPosition`. */
    logicalToVisual: number[];
    /**
     * Paint content per visual position: the logical item content with bidi
     * mirrored pairs substituted (rule L4) while the item sits on an RTL
     * embedding level. Identical to the logical content everywhere else.
     * Hit testing and selection MUST keep using the logical `content`; only
     * the paint path may consume this field.
     */
    visualContents: string[];
    /** The base direction the permutation was resolved against. */
    direction: TextDirection;
    /** `false` when the visual order equals the logical order (nothing to do). */
    reordered: boolean;
}

function mirrorBidiChars(content: string): string {
    if (!content) {
        return content;
    }

    let mirrored = false;
    let result = '';

    for (const char of Array.from(content)) {
        const replacement = MIRRORED[char];

        if (replacement !== undefined) {
            mirrored = true;
            result += replacement;
        } else {
            result += char;
        }
    }

    return mirrored ? result : content;
}

function buildVisualOrderResult(
    order: number[],
    direction: TextDirection,
    items?: Array<{ content: string }>,
    levels?: number[]
): IVisualOrderForItems {
    const logicalToVisual = new Array<number>(order.length);

    for (let visualIndex = 0; visualIndex < order.length; visualIndex++) {
        logicalToVisual[order[visualIndex]] = visualIndex;
    }

    const reordered = order.some((logicalIndex, visualIndex) => logicalIndex !== visualIndex);
    const visualContents = order.map((logicalIndex) => {
        const content = items?.[logicalIndex]?.content ?? '';

        // Rule L4: paired brackets painted on an odd (RTL) level are drawn
        // with their mirrored counterpart so "(a)" inside Arabic text shows
        // the opening parenthesis on the right, like native RTL rendering.
        return levels && levels[logicalIndex] % 2 === 1 ? mirrorBidiChars(content) : content;
    });

    return {
        order,
        visualToLogical: order,
        logicalToVisual,
        visualContents,
        direction,
        reordered,
    };
}

/**
 * One atomic unit of the pre-grouped item sequence.
 *
 * Number blocks (rule W4/W5 pre-grouping) merge every digit item plus the
 * separators between them into a single LTR unit that is reordered as a
 * whole and expanded back to its members afterwards. Every other layout
 * item is a single-member unit.
 */
interface IVisualUnit {
    /** Logical item indexes covered by this unit (contiguous, ascending). */
    members: number[];
    /** Bidi class used while resolving the unit sequence. */
    cls: BidiCharClass;
    /** Joined content of all members (feeds W4 inside `resolveLevels`). */
    content: string;
}

function buildAtomicUnits(classes: BidiCharClass[], items: Array<{ content: string }>): IVisualUnit[] {
    const isNumber = (cls: BidiCharClass): boolean => cls === BidiCharClass.EN || cls === BidiCharClass.AN;
    const isNumberNeutral = (index: number): boolean =>
        classes[index] === BidiCharClass.N && NUMBER_NEUTRAL_RE.test(items[index].content ?? '');

    const units: IVisualUnit[] = [];
    let i = 0;

    while (i < items.length) {
        if (!isNumber(classes[i])) {
            units.push({ members: [i], cls: classes[i], content: items[i].content ?? '' });
            i++;
            continue;
        }

        // Number block: digits plus neutrals that sit between digits
        // (W4 "." / ":" / "،" between two numbers, W5 "%" / "$" adjacent
        // to a number). The block is atomic: it is never reordered inside.
        const members: number[] = [i];
        let j = i + 1;

        while (j < items.length) {
            if (isNumber(classes[j])) {
                members.push(j);
                j++;
                continue;
            }

            if (isNumberNeutral(j)) {
                // Neutrals only join when another number follows behind them.
                let k = j;

                while (k < items.length && isNumberNeutral(k)) {
                    k++;
                }

                if (k < items.length && isNumber(classes[k])) {
                    while (j < k) {
                        members.push(j);
                        j++;
                    }
                    continue;
                }
            }

            break;
        }

        const hasEuropean = members.some((member) => classes[member] === BidiCharClass.EN);
        units.push({
            members,
            cls: hasEuropean ? BidiCharClass.EN : BidiCharClass.AN,
            content: members.map((member) => items[member].content ?? '').join(''),
        });
        i = j;
    }

    return units;
}

/**
 * Compute the visual (left-to-right) paint order of a sequence of layout
 * items (glyphs / word groups), given each item's text content.
 *
 * Items are classified by their first strong character, digit runs are
 * pre-grouped into atomic LTR blocks (W4/W5) and the unit sequence is then
 * reordered with the same UAX #9 subset used for strings. The neutral rules
 * N1/N2 operate on the whole item sequence, so a quote or bracket glyph is
 * resolved with the strong context ACROSS neighbouring glyph boundaries.
 * Multi-character units are treated as atomic: their inner text is already
 * handled by the canvas shaper when each glyph is painted.
 *
 * @returns the visual order together with the `visual -> logical` and
 * `logical -> visual` index maps, the L4-mirrored paint contents and the
 * resolved base direction, so that hit testing and selection rendering can
 * translate between the two orders while painting draws mirrored brackets.
 */
export function computeVisualOrderForItems(items: Array<{ content: string }>, baseDirection?: TextDirection): IVisualOrderForItems {
    if (items.length < 2) {
        return buildVisualOrderResult(items.map((_, index) => index), baseDirection ?? 'ltr', items);
    }

    const classes = items.map((item) => getFirstStrongClass(item.content) ?? BidiCharClass.N);

    if (!classes.some((cls) => cls === BidiCharClass.R || cls === BidiCharClass.AL)) {
        // Fast path: no strong RTL item, keep logical order (no mirroring
        // either: nothing sits on an RTL level).
        return buildVisualOrderResult(items.map((_, index) => index), baseDirection ?? 'ltr', items);
    }

    const hasStrong = classes.some((cls) => cls !== BidiCharClass.N);
    const direction = baseDirection ?? (hasStrong
        ? detectTextDirection(items.map((item) => item.content).join(''))
        : 'ltr');
    const baseLevel = direction === 'rtl' ? 1 : 0;

    // Pre-group digit runs into atomic LTR units (W4/W5), then resolve the
    // unit sequence (neutrals + implicit levels) and reorder it (L2).
    const units = buildAtomicUnits(classes, items);
    const unitLevels = resolveLevels(
        units.map((unit) => unit.cls),
        baseLevel,
        units.map((unit) => unit.content)
    );
    const unitOrder = reorderIndexes(unitLevels);

    // Expand the unit permutation back to per-item order and per-item levels.
    // `levelsForLogical` is indexed by LOGICAL item index (matching what
    // `buildVisualOrderResult` looks up), not by visual position.
    const order: number[] = [];
    const levelsForLogical: number[] = new Array(items.length).fill(0);

    for (let visualIndex = 0; visualIndex < unitOrder.length; visualIndex++) {
        const unitIndex = unitOrder[visualIndex];
        const unitLevel = unitLevels[unitIndex];

        for (const member of units[unitIndex].members) {
            order.push(member);
            levelsForLogical[member] = unitLevel;
        }
    }

    return buildVisualOrderResult(order, direction, items, levelsForLogical);
}

// ---------------------------------------------------------------------------
// Explicit base direction (paragraph / section style wins over auto-detect)
// ---------------------------------------------------------------------------

/**
 * Numeric mirror of `TextDirection` from `@univerjs/core`
 * (`UNSPECIFIED = 0`, `LEFT_TO_RIGHT = 1`, `RIGHT_TO_LEFT = 2`).
 * Mirrored here so this module stays dependency free.
 */
const CORE_TEXT_DIRECTION = {
    UNSPECIFIED: 0,
    LEFT_TO_RIGHT: 1,
    RIGHT_TO_LEFT: 2,
} as const;

/**
 * Resolve the explicit base direction with the documented priority:
 *
 * 1. `paragraphStyle.direction` (most specific, paragraph scope)
 * 2. `sectionBreakConfig.contentDirection` (section scope)
 * 3. `null` -> fall back to UAX #9 rule P2 auto-detection on the line content
 *
 * An explicit direction must always win over content-based detection,
 * otherwise an explicit RTL paragraph whose line happens to be pure English
 * or numbers would be misaligned and mis-ordered.
 */
export function resolveExplicitBaseDirection(paragraphDirection?: number, sectionDirection?: number): TextDirection | null {
    // Paragraph scope is the most specific one: it wins even when it
    // disagrees with the section direction (an explicit LTR paragraph inside
    // an RTL section stays LTR). UNSPECIFIED counts as "not set".
    return mapCoreTextDirection(paragraphDirection) ?? mapCoreTextDirection(sectionDirection);
}

function mapCoreTextDirection(value?: number): TextDirection | null {
    if (value === CORE_TEXT_DIRECTION.RIGHT_TO_LEFT) {
        return 'rtl';
    }

    if (value === CORE_TEXT_DIRECTION.LEFT_TO_RIGHT) {
        return 'ltr';
    }

    return null;
}

/**
 * Direction of the first strong character of a single glyph, or `null` when
 * the content has no strong character (spaces, punctuation, digits are not
 * strong here). Used to decide which side of a glyph a caret belongs to.
 */
export function getStrongDirection(content: string): 'rtl' | 'ltr' | null {
    const chars = Array.from(content ?? '');

    for (const char of chars) {
        const cls = getBidiCharClass(char.codePointAt(0)!);

        if (cls === BidiCharClass.R || cls === BidiCharClass.AL) {
            return 'rtl';
        }
        if (cls === BidiCharClass.L) {
            return 'ltr';
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Cached glyph reordering (hot layout path)
// ---------------------------------------------------------------------------

const VISUAL_ORDER_CACHE_LIMIT = 800;
const visualOrderCache = new Map<string, IVisualOrderForItems>();

function visualOrderCacheKey(items: Array<{ content: string }>, baseDirection: TextDirection | undefined, fontStyleKey: string): string {
    // The separator keeps different glyph segmentations of the same text on
    // different keys ("ab" as one glyph vs "a"+"b"). The version prefix
    // invalidates entries computed by an older algorithm revision.
    let key = `v3\u0000${baseDirection ?? 'auto'}\u0000${fontStyleKey}\u0000`;

    for (const item of items) {
        key += `${item.content ?? ''}\u0000`;
    }

    return key;
}

/**
 * Cached variant of `computeVisualOrderForItems` for the layout hot path.
 *
 * `applyRtlGlyphOrder` re-runs the bidi analysis for every divide on every
 * re-layout, and the selection renderer asks for the same permutation again.
 * The permutation only depends on the glyph segmentation, the base direction
 * and (defensively) the font style, so the result is memoized on that key.
 * A plain insertion-ordered LRU keeps the cache bounded.
 *
 * @param glyphGroup layout items (glyphs) in logical order.
 * @param baseDirection optional explicit base direction; auto-detected when omitted.
 * @param fontStyleKey optional font signature (e.g. `fontStyle.fontString`);
 * it is only part of the cache key, the permutation itself is font independent.
 */
export function computeVisualOrderForGlyphGroup(
    glyphGroup: Array<{ content: string }>,
    baseDirection?: TextDirection,
    fontStyleKey = ''
): IVisualOrderForItems {
    const key = visualOrderCacheKey(glyphGroup, baseDirection, fontStyleKey);
    const cached = visualOrderCache.get(key);

    if (cached) {
        // Refresh for LRU semantics.
        visualOrderCache.delete(key);
        visualOrderCache.set(key, cached);

        return cached;
    }

    const result = computeVisualOrderForItems(glyphGroup, baseDirection);

    visualOrderCache.set(key, result);

    if (visualOrderCache.size > VISUAL_ORDER_CACHE_LIMIT) {
        const oldestKey = visualOrderCache.keys().next().value;

        if (oldestKey !== undefined) {
            visualOrderCache.delete(oldestKey);
        }
    }

    return result;
}

/** Test/debug helper: drop every memoized glyph reordering. */
export function clearRtlVisualOrderCache(): void {
    visualOrderCache.clear();
}

/**
 * Whether the caret halves of a glyph must be mirrored when converting a
 * click position into a logical offset.
 *
 * Strong RTL glyphs are always mirrored. Neutral glyphs (spaces between
 * Arabic words, trailing punctuation) inherit the divide's base direction,
 * while strong LTR glyphs keep plain LTR caret semantics even inside an RTL
 * line.
 */
export function isMirroredCaretGlyph(content: string, divideIsRtl: boolean): boolean {
    const strong = getStrongDirection(content);

    if (strong === 'rtl') {
        return true;
    }

    if (strong === null) {
        return divideIsRtl;
    }

    return false;
}

/**
 * Whether the given canvas context (or its underlying 2D context) supports
 * the `direction` attribute used to resolve bidi with the platform shaper.
 */
export function supportsCanvasBidiDirection(ctx: unknown): boolean {
    try {
        return typeof (ctx as { direction?: unknown } | null)?.direction === 'string';
    } catch {
        return false;
    }
}
