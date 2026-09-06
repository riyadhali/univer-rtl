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

import type { IParagraphStyle, Nullable } from '@univerjs/core';
import type {
    IDocumentSkeletonDivide,
    IDocumentSkeletonLine,
    IDocumentSkeletonPage,
} from '../../../../../basics/i-document-skeleton-cached';
import type { ISectionBreakConfig } from '../../../../../basics/interfaces';
import type { TextDirection } from '../../../../../basics/rtl-processor';
import type { DataStreamTreeNode } from '../../../view-model/data-stream-tree-node';
import type { DocumentViewModel } from '../../../view-model/document-view-model';
import { HorizontalAlign, WrapStrategy } from '@univerjs/core';
import { cjk } from '../../../../../basics/cjk-regexp';
import { computeVisualOrderForItems, containsRTL } from '../../../../../basics/rtl-processor';
import {
    isCjkLeftAlignedPunctuation,
    isCjkRightAlignedPunctuation,
} from '../../../../../basics/tools';
import { BreakPointType } from '../../line-breaker/break';
import { isLetter } from '../../line-breaker/enhancers/utils';
import { createHyphenDashGlyph, glyphShrinkLeft, glyphShrinkRight, setGlyphGroupLeft } from '../../model/glyph';
import { getFontConfigFromLastGlyph, getGlyphGroupWidth } from '../../tools';

// How much a character should hang into the end margin.
// For more discussion, see:
// https://recoveringphysicist.com/21/
// https://www.w3.org/TR/clreq/#hanging_punctuation_marks_at_line_end
function overhang(c: string): number {
    switch (c) {
        // Dashes.
        case '–':
        case '—': {
            return 0.2;
        }
        // Punctuation.
        case '.':
        case ',': {
            return 0.8;
        }
        case ':':
        case ';': {
            return 0.3;
        }
        // Arabic
        case '\u{60C}':
        case '\u{6D4}': {
            return 0.4;
        }
        default: {
            return 0;
        }
    }
}

function getDivideShrinkability(divide: IDocumentSkeletonDivide): number {
    const { glyphGroup } = divide;
    let shrinkability = 0;

    for (const glyph of glyphGroup) {
        const [left, right] = glyph.adjustability.shrinkability;

        shrinkability += left + right;
    }

    return shrinkability;
}

function getDivideStretchability(divide: IDocumentSkeletonDivide): number {
    const { glyphGroup } = divide;
    let stretchability = 0;

    for (const glyph of glyphGroup) {
        const [left, right] = glyph.adjustability.stretchability;

        stretchability += left + right;
    }

    return stretchability;
}

function getJustifiables(divide: IDocumentSkeletonDivide): number {
    const justifiables = divide.glyphGroup.filter((glyph) => glyph.isJustifiable).length;
    const lastGlyph = divide.glyphGroup[divide.glyphGroup.length - 1];

    // CJK character at line end should not be adjusted.
    if (cjk.hasCJK(lastGlyph.content)) {
        return justifiables - 1;
    }

    return justifiables;
}

function adjustGlyphsInDivide(divide: IDocumentSkeletonDivide, justificationRatio: number, extraJustification: number) {
    for (const glyph of divide.glyphGroup) {
        const adjustabilityLeft = justificationRatio < 0
            ? glyph.adjustability.shrinkability[0]
            : glyph.adjustability.stretchability[0];
        const adjustabilityRight = justificationRatio < 0
            ? glyph.adjustability.shrinkability[1]
            : glyph.adjustability.stretchability[1];

        const justificationLeft = adjustabilityLeft * justificationRatio;
        let justificationRight = adjustabilityRight * justificationRatio;

        if (glyph.isJustifiable) {
            justificationRight += extraJustification;
        }

        glyph.width += justificationLeft + justificationRight;
        glyph.xOffset += justificationLeft;
    }

    setGlyphGroupLeft(divide.glyphGroup);
}

function distributeGlyphsInDivide(divide: IDocumentSkeletonDivide, remaining: number): boolean {
    if (remaining <= 0) {
        return false;
    }

    const visibleGlyphs = divide.glyphGroup.filter((glyph) => glyph.content !== '' && glyph.width > 0);

    if (visibleGlyphs.length < 2) {
        return false;
    }

    const extraGap = remaining / (visibleGlyphs.length - 1);

    for (let i = 0; i < visibleGlyphs.length - 1; i++) {
        visibleGlyphs[i].width += extraGap;
    }

    setGlyphGroupLeft(divide.glyphGroup);
    return true;
}

/**
 * When aligning text horizontally within a document,
 * it may be ineffective if the total line width is not initially calculated.
 * Therefore, multiple calculations are performed, which may impact performance.
 * Needs optimization for efficiency.
 */
function shouldAllowOverflowHorizontalOffset(sectionBreakConfig: ISectionBreakConfig): boolean {
    const wrapStrategy = sectionBreakConfig.renderConfig?.wrapStrategy;

    return wrapStrategy === WrapStrategy.OVERFLOW;
}

function getGlyphGroupInkBounds(divide: IDocumentSkeletonDivide): { left: number; right: number } | null {
    if (divide.glyphGroup.length === 0) {
        return null;
    }

    let left = Infinity;
    let right = -Infinity;

    for (const glyph of divide.glyphGroup) {
        const glyphLeft = glyph.left + glyph.xOffset;
        left = Math.min(left, glyphLeft);
        right = Math.max(right, glyphLeft + glyph.bBox.width);
    }

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return null;
    }

    return { left, right };
}

function horizontalAlignHandler(
    line: IDocumentSkeletonLine,
    horizontalAlign: HorizontalAlign,
    allowOverflowHorizontalOffset = false
) {
    const { divides } = line;

    for (let i = 0; i < divides.length; i++) {
        const divide = divides[i];
        const { width } = divide;

        if (divide.glyphGroup.length === 0) {
            divide.glyphGroupWidth = 0;
            divide.paddingLeft = 0;
            continue;
        }

        let glyphGroupWidth = getGlyphGroupWidth(divide);

        divide.glyphGroupWidth = glyphGroupWidth;

        if (width === Number.POSITIVE_INFINITY) {
            continue;
        }

        if (divide.isFull) {
            let remaining = width - glyphGroupWidth;

            // Handle hanging punctuation to the right.
            // TODO: @jocs Handle hanging punctuation to the left if text dir is RTL.
            if (divide.glyphGroup.length > 1) {
                const lastGlyph = divide.glyphGroup[divide.glyphGroup.length - 1];
                const amount = overhang(lastGlyph.content) * lastGlyph.width;

                remaining += amount;
            }

            let justificationRatio = 0;
            let extraJustification = 0;
            const shrink = getDivideShrinkability(divide);
            const stretch = getDivideStretchability(divide);

            if (remaining < 0 && shrink > 0) {
                // Attempt to reduce the length of the line, using shrinkability.
                justificationRatio = Math.max(remaining / shrink, -1.0);
                remaining = Math.min(remaining + shrink, 0);
            } else if (horizontalAlign === HorizontalAlign.JUSTIFIED) {
                // Attempt to increase the length of the line, using stretchability.
                if (stretch > 0) {
                    justificationRatio = Math.min(remaining / stretch, 1.0);
                    remaining = Math.max(remaining - stretch, 0);
                }

                const justifiables = getJustifiables(divide);

                if (justifiables > 0 && remaining > 0) {
                    extraJustification = remaining / justifiables;
                    remaining = 0;
                }
            }

            if (justificationRatio !== 0 || extraJustification !== 0) {
                // Extrude or stretch row so that they fit within a specified width,
                // or they can be squeezed or stretched to justify the row.
                adjustGlyphsInDivide(divide, justificationRatio, extraJustification);
                // Recalculate the glyph group width, because we adjust the width and xOffset of glyphs.
                glyphGroupWidth = getGlyphGroupWidth(divide);
                divide.glyphGroupWidth = glyphGroupWidth;
            }
        }

        const inkBounds = allowOverflowHorizontalOffset ? getGlyphGroupInkBounds(divide) : null;

        if (horizontalAlign === HorizontalAlign.DISTRIBUTED) {
            if (distributeGlyphsInDivide(divide, width - glyphGroupWidth)) {
                glyphGroupWidth = getGlyphGroupWidth(divide);
                divide.glyphGroupWidth = glyphGroupWidth;
            }
            divide.paddingLeft = 0;
        } else if (horizontalAlign === HorizontalAlign.CENTER && inkBounds) {
            divide.paddingLeft = width / 2 - (inkBounds.left + inkBounds.right) / 2;
        } else if (horizontalAlign === HorizontalAlign.RIGHT && inkBounds) {
            divide.paddingLeft = width - inkBounds.right;
        } else if (horizontalAlign === HorizontalAlign.CENTER) {
            divide.paddingLeft = (width - glyphGroupWidth) / 2;
        } else if (horizontalAlign === HorizontalAlign.RIGHT) {
            divide.paddingLeft = width - glyphGroupWidth;
        }

        if (!allowOverflowHorizontalOffset) {
            // To fix https://github.com/dream-num/univer-pro/issues/2930
            divide.paddingLeft = Math.max(divide.paddingLeft, 0);
        }
    }
}

// If the last glyph is a CJK character adjusted by [`addCJKLatinSpacing`],
// restore the original width.
function restoreLastCJKGlyphWidth(line: IDocumentSkeletonLine) {
    for (const divide of line.divides) {
        const lastGlyph = divide.glyphGroup[divide.glyphGroup.length - 1];

        if (
            lastGlyph &&
            divide.isFull &&
            cjk.hasCJKText(lastGlyph.content) &&
            lastGlyph.width - lastGlyph.xOffset > lastGlyph.bBox.width
        ) {
            const shrinkAmount = lastGlyph.width - lastGlyph.xOffset - lastGlyph.bBox.width;

            lastGlyph.width -= shrinkAmount;
            lastGlyph.adjustability.shrinkability[1] = 0;
        }
    }
}

// If the first or last glyph is a CJK punctuation, we want to shrink it.
// See Requirements for Chinese Text Layout, Section 3.1.6.3
// Compression of punctuation marks at line start or line end
function shrinkStartAndEndCJKPunctuation(line: IDocumentSkeletonLine) {
    for (const divide of line.divides) {
        const glyphGroupLength = divide.glyphGroup.length;
        if (glyphGroupLength < 2) {
            continue;
        }

        const firstGlyph = divide.glyphGroup[0];
        const lastGlyph = divide.glyphGroup[glyphGroupLength - 1];

        if (isCjkRightAlignedPunctuation(firstGlyph.content)) {
            const shrinkAmount = firstGlyph.adjustability.shrinkability[0];

            glyphShrinkLeft(firstGlyph, shrinkAmount);
        }

        if (isCjkLeftAlignedPunctuation(lastGlyph.content)) {
            const shrinkAmount = lastGlyph.adjustability.shrinkability[1];

            glyphShrinkRight(lastGlyph, shrinkAmount);
        }

        setGlyphGroupLeft(divide.glyphGroup);
    }
}

// Add dash to the end of divide when divide is break by Hyphen.
function addHyphenDash(
    line: IDocumentSkeletonLine,
    viewModel: DocumentViewModel,
    paragraphNode: DataStreamTreeNode,
    sectionBreakConfig: ISectionBreakConfig,
    paragraphStyle: IParagraphStyle
) {
    for (const divide of line.divides) {
        const { glyphGroup, breakType } = divide;
        const lastGlyph = glyphGroup[glyphGroup.length - 1];

        if (lastGlyph && isLetter(lastGlyph.content) && breakType === BreakPointType.Hyphen) {
            const config = getFontConfigFromLastGlyph(lastGlyph, sectionBreakConfig, paragraphStyle);

            const hyphenDashGlyph = createHyphenDashGlyph(config);
            hyphenDashGlyph.parent = lastGlyph.parent;
            hyphenDashGlyph.left = lastGlyph.left + lastGlyph.width;
            divide.glyphGroup.push(hyphenDashGlyph);
            // In latin paragraph layout, most lines end with spaces,
            // and when hyphens are added to some lines, the hyphens will bulge out,
            // and when the ends are aligned, they will not appear to be aligned,
            // so the hyphenated divide needs to be compressed
            divide.width -= hyphenDashGlyph.width;
        }
    }
}

/**
 * Base direction of a line, chosen so that Arabic documents keep their RTL
 * flow even when a line STARTS with a Latin token ("GLM-5.3-Flash.. أحدث
 * ضربة صينية…"): the presence of any RTL character in the line makes the
 * line RTL — the Latin fragment paints at the line's right edge, exactly
 * like Word with an RTL paragraph flag. First-strong (UAX #9 P2) would
 * wrongly flip such lines to LTR. Pure-Latin lines stay LTR.
 */
function getLineBaseDirection(line: IDocumentSkeletonLine, docDefaultDirection: TextDirection): TextDirection {
    let content = '';

    for (const divide of line.divides) {
        for (const glyph of divide.glyphGroup) {
            content += glyph.content ?? '';

            if (content.length >= 256) {
                break;
            }
        }

        if (content.length >= 256) {
            break;
        }
    }

    if (containsRTL(content)) {
        return 'rtl';
    }

    // Strong LTR text keeps the line LTR even inside an RTL document.
    if (hasStrongLTR(content)) {
        return 'ltr';
    }

    // Empty or neutral-only lines ("(", quotes, digits) follow the
    // document's base direction instead of waiting for a strong character
    // ("late detection"): in an Arabic document a paragraph starts RTL from
    // birth, so "(" paints at the right edge and never flips.
    return docDefaultDirection;
}

// Scripts with strong LTR direction. Digits are deliberately excluded —
// they are bidi-weak and follow the paragraph direction.
const STRONG_LTR_PATTERN = /[A-Za-z\u00c0-\u024f\u0370-\u04ff\u0530-\u058f\u2e80-\u9fff\uac00-\ud7af]/;

function hasStrongLTR(content: string): boolean {
    return STRONG_LTR_PATTERN.test(content);
}

const RTL_LOCALE_PREFIXES = ['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'];

/**
 * The document's base direction comes from its locale ("تنسيق المستند"):
 * an ar-SA document opens paragraphs RTL by default.
 */
function isRtlLocale(locale: Nullable<string>): boolean {
    if (!locale) {
        return false;
    }

    const normalized = locale.toLowerCase().replace(/[-_]/g, '');
    return RTL_LOCALE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Weak/empty paragraphs inherit the direction of the nearest PRECEDING
 * paragraph with strong content — pressing Enter inside an Arabic paragraph
 * keeps the new (empty) paragraph RTL instead of "losing the memory" and
 * dropping the caret to the left. The document-locale default is the final
 * fallback. The scan walks BACKWARD over the raw dataStream (paragraph
 * boundaries are '\r'), so tables and other node boundaries in the paragraphs
 * array cannot break the chain.
 */
function getInheritedBaseDirection(viewModel: DocumentViewModel, paragraphStartIndex: number, docDefaultDirection: TextDirection): TextDirection {
    const dataStream = viewModel.getBody()?.dataStream ?? '';

    let end = paragraphStartIndex - 1;
    let scanned = 0;

    while (end > 0 && scanned < 3) {
        let start = end - 1;

        while (start > 0 && dataStream[start] !== '\r') {
            start--;
        }

        const text = dataStream.slice(start + 1, end);

        if (text.trim().length > 0) {
            if (containsRTL(text)) {
                return 'rtl';
            }

            if (hasStrongLTR(text)) {
                return 'ltr';
            }

            scanned++;
        }

        end = start;
    }

    return docDefaultDirection;
}

/**
 * Excel-like General alignment: when no horizontal alignment is configured,
 * right-to-left lines start from the right edge instead of the left one.
 */
function getEffectiveLineHorizontalAlign(line: IDocumentSkeletonLine, configured: HorizontalAlign, docDefaultDirection: TextDirection): HorizontalAlign {
    if (configured !== HorizontalAlign.UNSPECIFIED) {
        return configured;
    }

    return getLineBaseDirection(line, docDefaultDirection) === 'rtl' ? HorizontalAlign.RIGHT : HorizontalAlign.LEFT;
}

/**
 * Place right-to-left glyph runs at their correct visual positions.
 *
 * The document skeleton keeps glyphs in logical order and assigns `left`
 * positions cumulatively left-to-right, which reverses the visual word order
 * of Arabic sentences ("بسم الله" would paint "بسم" leftmost). This pass
 * computes the bidi visual order of the divide's glyphs and reassigns their
 * `left` values, so the first logical word paints at the right edge. Glyph
 * widths stay untouched: each multi-character glyph is still painted by the
 * canvas shaper as a correctly joined Arabic word.
 */
function applyRtlGlyphOrder(line: IDocumentSkeletonLine, docDefaultDirection: TextDirection) {
    // The line base direction is resolved ONCE (contains-RTL rule with the
    // document-locale default for weak lines) and passed to the reorder pass
    // — a Latin-leading line inside an Arabic paragraph is reordered as RTL
    // instead of flipping to LTR via first-strong detect.
    const baseDirection = getLineBaseDirection(line, docDefaultDirection);

    for (const divide of line.divides) {
        const { glyphGroup } = divide;

        if (glyphGroup.length < 2) {
            continue;
        }

        if (!glyphGroup.some((glyph) => containsRTL(glyph.content ?? ''))) {
            continue;
        }

        const order = computeVisualOrderForItems(glyphGroup.map((glyph) => ({ content: glyph.content ?? '' })), baseDirection);

        // Rule L4: hand the mirrored paint content (e.g. "(" drawn as ")",
        // "«" as "»") to the paint extension for glyphs sitting on an odd
        // (RTL) embedding level. The logical `content` stays untouched for
        // hit testing and selection.
        order.order.forEach((logicalIndex, visualIndex) => {
            const glyph = glyphGroup[logicalIndex];
            const paintContent = order.visualContents[visualIndex];

            glyph.rtlVisualContent = paintContent !== (glyph.content ?? '') ? paintContent : undefined;
        });

        if (!order.reordered) {
            continue;
        }

        let left = 0;

        for (const logicalIndex of order.order) {
            const glyph = glyphGroup[logicalIndex];

            glyph.left = left;
            left += glyph.width;
        }
    }
}

export function lineAdjustment(
    pages: IDocumentSkeletonPage[],
    viewModel: DocumentViewModel,
    paragraphNode: DataStreamTreeNode,
    sectionBreakConfig: ISectionBreakConfig
) {
    const { endIndex } = paragraphNode;
    const paragraph = viewModel.getParagraph(endIndex) || { startIndex: 0, paragraphId: 'para_render_fallback' };

    // The document locale decides the base direction of weak/empty lines,
    // refined by the nearest preceding strong paragraph (Enter inheritance).
    const docDefaultDirection: TextDirection = getInheritedBaseDirection(
        viewModel,
        paragraph.startIndex,
        isRtlLocale(viewModel.getSnapshot()?.locale) ? 'rtl' : 'ltr'
    );

    const { paragraphStyle = {} } = paragraph;
    const { horizontalAlign = HorizontalAlign.UNSPECIFIED } = paragraphStyle;
    for (const page of pages) {
        for (const section of page.sections) {
            for (const column of section.columns) {
                const { lines } = column;
                // Line breaking appends logical paragraph order; pagination moves
                // ordered suffixes. A long cell must not rescan its growing prefix
                // for every paragraph's punctuation and alignment pass.
                let low = 0;
                let high = lines.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    if (lines[middle].paragraphIndex < paragraph.startIndex) {
                        low = middle + 1;
                    } else {
                        high = middle;
                    }
                }
                for (let index = low; index < lines.length && lines[index].paragraphIndex === paragraph.startIndex; index++) {
                    const line = lines[index];
                    shrinkStartAndEndCJKPunctuation(line);
                    restoreLastCJKGlyphWidth(line);
                    addHyphenDash(line, viewModel, paragraphNode, sectionBreakConfig, paragraphStyle);
                    // Handle horizontal align: left\center\right\justified\distributed.
                    horizontalAlignHandler(line, getEffectiveLineHorizontalAlign(line, horizontalAlign, docDefaultDirection), shouldAllowOverflowHorizontalOffset(sectionBreakConfig));
                    // Place right-to-left glyph runs at their correct visual positions.
                    applyRtlGlyphOrder(line, docDefaultDirection);
                }
            }
        }
    }
}
