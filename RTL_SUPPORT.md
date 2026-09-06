# دعم العربية و RTL في Univer — التوثيق الشامل

> **المطوّر / Developer**: **Riyadh Ali** — المطور المسؤول عن دعم العربية والاتجاه RTL، مع مساهمات من وكلاء ذكاء اصطناعي في الاختبار والتوثيق والمراجعة.
> **Developer**: Riyadh Ali — lead developer of Arabic/RTL support, with AI-agent contributions in testing, documentation, and review.

> **الحالة الحالية (النسخة النشطة)**: `univer-dev` — أساس upstream بخط `1.0.0-beta.2` + التزامات RTL (v1 + مؤشر L4) + تطويرات الجلسة: **توافق فايرفوكس + سلامة تحرير الهيدر/الفوتر** (موثقة في §٣.٩–§٣.١٤ و§٤.ب).
> **النسخ المرجعية السابقة**: `Univer 1.0.0-beta.2` الرسمي — مُنفَّذ ومُجرَّب ومؤكَّد حياً؛ `Univer 0.25.1` (المستقرة) — مُنفَّذة ومُجرَّبة بنفس المنطق.
> **أرشيف الكراك**: `web/js/crack/univer-dev_1/` = نسخة مرآة للملفات المطوَّرة (21 ملفاً بمساراتها) قابلة للطيّ فوق نسخة نظيفة.

---

## ١. الفلسفة المعمارية (القواعد الملزمة)

1. **RTL عرضي خالص**: أي تعديل RTL يجب أن يبقى في طبقة العرض (المواقع البصرية، المحتوى المرسوم، مستطيلات التضليل، جهة المؤشر). **ممنوع منعاً باتاً** لمس الإزاحات المنطقية أو خريطة المؤشر (`count/st/ed`) أو نموذج البيانات — المؤشر والإدخال يجريان على المسار الأصلي غير المعدّل.
2. **قاعدة اتجاه السطر = «يحوي عربياً»** (contains-RTL) لا first-strong: سطر يبدأ برمز لاتيني (`GLM-5.3-Flash..`) داخل فقرة عربية يجب أن يبدأ من اليمين — قاعدة UAX #9 P2 تكسر هذا.
3. **الكلمة العربية غليف واحد**: `ArabicHandler` يجمع الكلمة كلها في glyph واحد وتُرسم بنداء `fillText` واحد، فيتكفل المتصفح بالتشكيل والوصل (جودة OpenType كاملة مع أي خط عربي).
4. **الفقرة الضعيفة ترث الاتجاه**: فقرة فارغة أو حيادية فقط (`(`، أرقام، اقتباس) تأخذ اتجاه أقرب فقرة سابقة ذات محتوى قوي، ثم لغة المستند، ثم LTR.
5. **مسؤولية العرض RTL مملوكة لمحرك engine-render حصراً**: أي مسار تخطيط موازٍ (مثل worker) يعمل على المسار LTR المُثبَت — انظر §٣.١٠ (إجبار اتجاه الجلسة في worker على `ltr`).

---

## ٢. خريطة الملفات المعدّلة

### أ) طبقة RTL الأساسية (v1 — beta.2/0.25.1)
| الملف | الدور في RTL |
|---|---|
| `packages/engine-render/src/basics/rtl-processor.ts` | **المعالج المستقل v2** (1331 سطراً، بلا اعتماديات): `containsRTL`, `detectTextDirection`, `resolveBidi` (W2/W4/N1/N2/I1/I2 + L2 + L4), `computeVisualOrderForItems` → يعيد `IVisualOrderForItems { order, reordered, visualContents }` |
| `packages/engine-render/src/basics/index.ts` | تصدير واجهات المعالج |
| `packages/engine-render/src/basics/i-document-skeleton-cached.ts` | حقل `rtlVisualContent?` على الغليف (محتوى الرسم المعكوس L4 دون المساس بالمحتوى المنطقي) |
| `packages/engine-render/src/components/docs/layout/block/paragraph/line-adjustment.ts` | **قلب النظام في Docs**: `applyRtlGlyphOrder` (إعادة ترتيب مواقع `left` بصرياً) + `getLineBaseDirection` (contains-RTL + strong-LTR + ضعف) + `isRtlLocale` + `getInheritedBaseDirection` (وراثة Enter بمسح خلفي على dataStream) + ربط `rtlVisualContent` |
| `packages/engine-render/src/components/docs/layout/block/paragraph/language-ruler.ts` | `otherHandler` يتوقف عند أي حرف عربي — فلا تُفكَّك الكلمة العربية التي تلي الترقيم |
| `packages/engine-render/src/components/docs/extensions/font-and-base-line.ts` | رسم الغليف بمحتواه البصري `rtlVisualContent` عند وجوده (مراينة الأقواس L4) |
| `packages/engine-render/src/shape/text.ts` | `_drawLineText`: رسم سطر كامل بضبط `ctx.direction` (نص الخلايا والأشكال) |
| `packages/engine-render/src/components/sheets/extensions/font.ts` | محاذاة خلية Sheets ذات قيمة RTL إلى اليمين عند غياب محاذاة صريحة |
| `packages/docs-ui/src/services/selection/convert-text-range.ts` | هندسة التحديد والمؤشر: **التحديد = كتلة بصرية واحدة** (min/max) بغض النظر عن اللغات، والمؤشر المنهار بجهة الغليف المحيطة |
| `packages/docs-ui/src/commands/commands/doc-delete.command.ts` | `getSingleCharLength`: Backspace/Delete يحذف **حرفاً واحداً** (وليس الغليف المدمج كاملاً)؛ وحدتا كود لزوج بديل يقطع الحد |
| `packages/engine-render/src/basics/__tests__/rtl-processor.spec.ts` | اختبارات المعالج (انظر §٧) |
| `RTL_SUPPORT.md` | هذا التوثيق |

### ب) طبقة الجلسة (فايرفوكس + سلامة التحرير — univer-dev)
| الملف | الدور |
|---|---|
| `packages/docs/src/layout-worker/index.ts` | **توافق فايرفوكس**: تسامح نسبي في فحص مقاييس خطوط الـ worker (§٣.٩) |
| `packages/docs/src/services/doc-layout-executor.service.ts` | إجبار اتجاه جلسة تخطيط الـ worker على `ltr` (§٣.١٠) |
| `packages/docs-ui/src/controllers/render-controllers/doc-input.controller.ts` | اختيار النموذج مصدر الحقيقة للإدخال (§٣.١١) |
| `packages/docs/src/commands/commands/core-editing.command.ts` | `InsertTextCommand` يمرر `trigger` → تقدّم منطقي متزامن للمؤشر (§٣.١٢) |
| `packages/docs/src/commands/mutations/core-editing.mutation.ts` | `scheduleDocumentSelectionUpdate` تختم `segmentId` على النطاقات المتقدمة (§٣.١٢) |
| `packages/docs-ui/src/commands/commands/break-line.command.ts` | `BreakLineCommand` يحمل `segmentId` — Enter داخل الهيدر يبقى في الهيدر (§٣.١٣) |
| `packages/docs-ui/src/services/selection/doc-selection-render.service.ts` | توسيع deferral «الاختيار المعلّق» لمقاطع الهيدر/الفوتر، محصوراً على المؤشر المنهار (§٣.١٤) |
| `packages/docs-ui/src/views/DocLayoutProgress.tsx` | توحيد نوع مفتاح الترجمة `LocaleKey` (سلامة بناء) |
| `packages/docs-ui/src/views/DocLayoutRecovery.tsx` | توحيد نوع مفتاح الترجمة `LocaleKey` (سلامة بناء) |

---

## ٣. سجل الإصلاحات (المشكلة ← الجذر ← الحل)

### ٣.١ انعكاس ترتيب الكلمات («بسم الله» ترسم معكوسة)
- **الجذر**: `layout-ruler.ts` يوزع مواقع `left` تراكمياً من اليسار بترتيب منطقي — لا BiDi في المحرك أصلاً.
- **الحل**: `applyRtlGlyphOrder` في `line-adjustment.ts`: يحسب الترتيب البصري لغليفات كل divide عبر `computeVisualOrderForItems` ويعيد تعيين `left` — العروض لا تُمسّ، أول كلمة منطقية ترسم في أقصى اليمين.

### ٣.٢ الأسطر التي تبدأ برمز لاتيني تنقلب LTR
- **الجذر**: اكتشاف first-strong (P2) يعطي LTR لسطر يبدأ بـ `GLM-5.3-Flash..`.
- **الحل**: `getLineBaseDirection` بقاعدة contains-RTL — أي محرف RTL في السطر = السطر كله RTL والشذرة اللاتينية ترسم بيمين السطر. (تطوير لاحق: النص اللاتيني القوي الخالص يبقى LTR حتى داخل مستند عربي — «Strong LTR keeps LTR».)
- **حالة التطوير الحالية في `getLineBaseDirection`**: (1) يحتوي RTL → rtl؛ (2) يحتوي strong-LTR → ltr؛ (3) فارغ/حيادي → اتجاه المستند (`isRtlLocale` على `snapshot.locale`) أو الوراثة من أقرب فقرة سابقة.

### ٣.٣ الكلمة بعد علامة الترقيم تظهر مقطّعة الحروف
- **الجذر**: `otherHandler` (المعالج اللاتيني) لا يتوقف عند الحروف العربية، فيبتلع الترقيم والكلمة التي تلحق به (`«كلمة`) حرفاً-حرفاً → حروف منفصلة بلا وصل.
- **الحل**: `otherHandler` يكسر الحلقة عند `hasArabic(char)` — الكلمة تسلم إلى `ArabicHandler` فتدمج غليفاً واحداً متصلاً. الترقيم يبقى غليفاً مستقلاً يضعه الترتيب البصري في مكانه الصحيح.
- **تنويه**: في 0.25.1 أُصلح أيضاً `ArabicHandler` نفسه (كان يستهلك `unshift` فيجمع الكلمة معكوسة — إصلاح رائد فضلية من المستخدم؛ النسخة الرسمية beta.2 تستخدم `push` أصلاً).

### ٣.٤ انقلاب المؤشر/التحديد — «تأخر الاكتشاف»
- **(أ) اتجاه المستند**: أسطر فارغة/حيادية كانت LTR دائماً. الحل: لغة المستند (`snapshot.locale` — `ar-SA`/`arSA`…) تحدد الافتراضي للأسطر الضعيفة عبر `isRtlLocale` — فقرة تبدأ بـ `(` في مستند عربي تولد RTL من اللحظة الأولى بلا انقلاب.
- **(ب) وراثة Enter**: بعد Enter من سطر عربي كان المؤشر يسقط يسار السطر الجديد. الحل: `getInheritedBaseDirection` — مسح **خلفي مباشر على dataStream** (حدود الفقرات `\r`، حتى 3 فقرات غير فارغة) يرث اتجاه أقرب فقرة سابقة قوية. المسح الخلفي الخام صُمم بعد أن أثبت القياس أن المرور على مصفوفة `paragraphs` ينكسر عند فقرات خلايا الجداول (شرائح فارغة).
- **ملاحظة قياس**: تطبيق العرض التجريبي على `:3002` يستخدم مستنداً إنجليزية (`enUS`) — لذا كانت وراثة اللغة وحدها لا تكفي، والوراثة من الفقرة السابقة هي الحاسمة.

### ٣.٥ التحديد يغطي جزءاً من السطر (أول قوس فقط)
- **الجذر**: هندسة التحديد كانت تحسب الحدّين مع مراينة كل حد على حدة، فتنكمش القاعدة إلى شريحة وسطية في الأسطر المختلطة.
- **الحل**: التحديد متعدد الغليفات = **كتلة بصرية واحدة** تغطي كامل مدى الغليفات المظللة (`min/max` على مواقعها) بغض النظر عن اللغات؛ المراينة تبقى للمؤشر المنهار فقط (جهة الغليف المحيطة).

### ٣.٦ Backspace يمسح كلمة كاملة
- **الجذر**: `DeleteLeftCommand` يحذف بطول الغليف السابق (`len: preGlyph.count`) — وكلمة العربية المدمجة غليف واحد متعدد الحروف.
- **الحل**: `getSingleCharLength(dataStream, offset, direction)` — يحذف حرفاً واحداً بالضبط (وحدتا كود لزوج بديل يقطع الحد). طُبّق على Backspace (المسار العادي + المسار قبل صورة) وDelete (للأمام).

### ٣.٧ مراينة الأقواس (L4)
- الغليفات على مستوى BiDi فردي تحصل على `rtlVisualContent` (مثلاً `(` ترسم `)`) — يمرَّر إلى الرسم عبر `font-and-base-line.ts`، بينما يبقى المحتوى المنطقي سليماً للاختبار النقر والتحديد.

### ٣.٨ توحيد واجهة المعالج (v2)
- `line-adjustment` كُتب أولاً على واجهة v2 (`order.order`/`order.reordered`/`order.visualContents`) بينما كان `rtl-processor.ts` يعيد `number[]` (v1) → انهيارات `order.order undefined` و`r.every is not a function` و`r is not iterable`.
- **الحل**: توحيد `rtl-processor.ts` في النسختين على نسخة v2 الكاملة (1331 سطراً) + `if (!order.reordered) continue` + المرور على `order.order`.

### ٣.٩ فايرفوكس: رفض worker سليم أثناء فحص القدرات (DocsLayoutWorkerCapabilityError)
- **الجذر**: `_verifyCapabilities` في `layout-worker/index.ts` كان يقارن مقاييس نص استكشافي (27 محرفاً) بين الـ main thread والـ worker بحد مطلق `FONT_METRICS_TOLERANCE = 1px`. **فايرفوكس يكمّم تقدم الغليف في OffscreenCanvas إلى بكسل كامل** بينما كَنْفَس DOM يحتفظ بالكسور (قياس فعلي على نفس الجهاز: DOM `w=230.83` مقابل OffscreenCanvas `w=231.87` ≈ 1.03px ≈ 0.45% — ضوضاء تقريب غير مؤذية). كروم يطابق تماماً. النتيجة: حد 1px المطلق كان يرفض worker سليماً تماماً على فايرفوكس → عاصفة `DocsLayoutWorkerCapabilityError` + استرداد فاشل (بيئات الخطوط المكسورة فعلاً تختلف بعشرات البكسلات).
- **الحل**: مقياس التسامح **نسبي مع القيمة** (`abs(a-b) <= max(floor, value × ratio)`) مع إبقاء حد أدنى مطلق للنصوص القصيرة فقط. الفرق المكسور الحقيقي (خطوط ناقصة/بلا دعم نصي) ما زال يُرفض.

### ٣.١٠ worker: اتجاه جلسة التخطيط LTR إجبارياً
- **الجذر**: خاصية «تخطيط واعٍ بالاتجاه» في الـ worker upstream عمل قيد التطوير (WIP) وكان يرسم المقاطع المختلطة معكوسة الأحرف في **معاينة الهيدر/الفوتر** (ghost preview).
- **الحل**: في `doc-layout-executor.service.ts` عند إنشاء جلسة الـ worker، يُمرَّر `direction: 'ltr'` ثابتاً مع تعليق يشرح: العرض RTL مملوك بالكامل لطبقة engine-render (contains-RTL reorder + L4) — جلسة التخطيط تعمل دائماً على المسار LTR المُثبَت.

### ٣.١١ إدخال body: حماية من «مستمع متأخر» (كلمات تختلط)
- **الجذر**: `activeRange` المعطى من حدث الإدخال (doc-selection-render) **مشتق من الـ skeleton** الذي يحدّثه worker التخطيط بشكل غير متزامن — بعد طفرة (Backspace/Enter/مسافة تعيد التخطيط) يمكن أن يكون متأخراً أو معاداً للصفر، فتقع الحروف في إزاحة خاطئة («how are you» → «hwo ha»).
- **الحل**: في `doc-input.controller.ts` — اختيار النموذج `DocSelectionManagerService.getActiveTextRange()` هو **مصدر الحقيقة** (يتقدم بشكل متزامن مع كل طفرة عبر `scheduleDocumentSelectionUpdate`)؛ يُفضَّل كلما وصف نفس المقطع (`segmentId` مطابق)، والرجوع لاختيار العرض فقط عند غيابه.

### ٣.١٢ الهيدر/الفوتر: تخلف إزاحة الإدخال بخطوة («yemen» → «yemne»)
- **الجذران**: (أ) طفرة `InsertTextCommand` لم تكن تمرر `trigger`، فكان `scheduleDocumentSelectionUpdate` يُرجئ تقدّم مؤشر النموذج لدورة render غير متزامنة تعيد اشتقاق الموضع من skeleton قديم (سباق عند سرعة كتابة بشرية)؛ (ب) النطاقات المتقدمة في النموذج **لا تحمل `segmentId`**، فحارس §٣.١١ (`modelRange.segmentId === activeRange.segmentId`) يفشل في الهيدر (`''` ≠ `'header-default'`) ويسقط على range العرض القديم.
- **الحل**: (أ) `core-editing.command.ts`: `trigger: InsertTextCommand.id` في بارامترات الطفرة → تقدّم منطقي متزامن من `startOffset + cursorMove` بالضبط (مطابقة لسلوك `BreakLineCommand` الحالي و`doesMutationScheduleLocalSelectionUpdate`)؛ (ب) `core-editing.mutation.ts`: `scheduleDocumentSelectionUpdate` يختم `segmentId: textRange.segmentId ?? params.segmentId ?? ''` على كل نطاق متقدم.
- **النتيجة**: الكتابة في الهيدر سليمة ومتتالية (تحقق: إزاحات رتيبة 36→61 عبر مسافات/Enter/عربي/لاتيني) في كروم وفايرفوكس معاً.

### ٣.١٣ Enter داخل الهيدر يكتب في الـ body (اهتزاز الصفحة)
- **الجذر**: `BreakLineCommand` لم يكن يمرر `segmentId` في طفرة `RichTextEditingMutation` → الطفرة تُنسب للـ body (`segmentId:''`) بينما أفعالها تستهدف مقطع الهيدر — سوء نطاق يعيد ضبط النموذج/التحديد على غير المحل (وكان يظهر أحياناً كإدخال `\r` فعلي في الـ body فيعيد تدفق الصفحة كلها = «اهتزاز»).
- **الحل**: `break-line.command.ts`: إضافة `segmentId` (المحلول من `activeTextRange`) إلى بارامترات الطفرة — مطابقة لـ `InsertTextCommand`.

### ٣.١٤ حذف تحديد في الهيدر ينهار (`ReferenceError: endOffset is not defined`)
- **الجذر**: سطر تشخيص `[bs-diag]` في `doc-delete.command.ts` كان يشير إلى `endOffset` غير معرّفة في النطاق (المستخرجات `startOffset, collapsed` فقط) — ينهار **قبل** تنفيذ القص، فأي حذف مع تحديد (تحديد الكل + Backspace/Delete أو قائمة السياق) «لا يستجيب».
- **الحل**: إزالة سطر التشخيص المعطوب نهائياً (بقي مسار القص `getTextRangesWhenDelete` + `CutContentCommand` سليماً). تحقق: تحديد كلمة أو Ctrl+A ثم حذف = بلا أخطاء.

### ٣.١٥ الهيدر/الفوتر: حماية المؤشر أثناء التخطيط المعلّق (deferral)
- **الجذر**: آلية «الاختيار المعلّق» في `doc-selection-render.service.ts` (عدم تطبيق ranges أثناء تخطيط `edit` غير مكتمل حتى لا تُرسم هندسة قديمة) كانت مشروطة بـ `currentSegmentId === ''` (body فقط) — الهيدر/الفوتر بلا حماية: صدى render (إعادة اشتقاق من skeleton قديم) يكتب فوق مؤشر النموذج المتقدم.
- **الحل**: توسيع الشرط ليشمل كل المقاطع (مع بقاء فحص هوية النطاقات كما هو). **ثم حصر لاحق**: deferral للنطاقات **المنهارة فقط** (المؤشر أثناء الكتابة) — لأن التحديدات غير المنهارة (تظليل/تنسيق) يجب أن تُرسم فوراً (§٨-ب).

### ٣.١٦ (تشخيص ثم إزالة) سجلات التتبع
- أُضيفت سجلات `[ins]`/`[mut]`/`[bs-cmd]`/`[bs-diag]` في أوامر التحرير لتشخيص المشاكل أعلاه ثم **أُزيلت كلها** بعد الاكتمال. بقي أثران تشخيصيان اختياريان للإزالة لاحقاً: `[fb]` في `font-and-base-line.ts` و`[rtl-paint]` في `shape/text.ts` (مقيدان/مشروطان، لا يؤثران على السلوك).

---

## ٤. مستويات RTL — الحالة

| المستوى | الحالة |
|---|---|
| **المستند (Docs)** | ✓ منجز: لغة المستند تحدد اتجاه الأسطر الضعيفة + وراثة الفقرة السابقة بعد Enter + إدخال/مؤشر سليمان في body والهيدر والفوتر |
| **هيدر/فوتر Docs** | ✓ منجز (جلسة): كتابة متتالية سليمة، Enter محلي، حذف تحديد آمن — عبر §٣.١١–§٣.١٥ |
| **الفقرة (Docs)** | جزئي: `paragraphStyle.horizontalAlign` (يمين/وسط/يسار) موجود ومُحترم؛ لا يوجد حقل «اتجاه فقرة» في نموذج upstream — يُضاف لاحقاً كامتداد إن لزم |
| **الجدول/الورقة (Sheets)** | upstream يملك `rightToLeft` في إعدادات الورقة + `SetWorksheetRightToLeftCommand` + mutation — لكن **بلا أي مستهلك في محرك العرض**: العلم يُخزَّن ولا يُقلب العمود A. تنفيذ قلب الأعمدة عمل منفصل بحجم محدد |
| **الكيبورد النشط** | المتصفح لا يوفر API للغة الكيبورد؛ `event.key` يعكسها لكل ضغطة (يمكن جعل أول ضغطة RTL ترفع اتجاه الفقرة). بعد الإصلاحات حاجتها شبه منتفية |

---

## ٥. ما لم يُلمس (عمداً)

- نموذج البيانات و`dataStream` والإزاحات المنطقية — كما هي حرفياً.
- خريطة المؤشر (`count/st/ed` على الغليفات) — لم تُعدَّل؛ الترتيب البصري يعيد تعيين `left` فقط.
- منطق الإدخال/IME وخط أنابيب mutations (باستثناء: تمرير `trigger` وختم `segmentId` الموصوفين — وهما إصلاحان يطابقان العقد القائم أصلاً في upstream مثل `BreakLineCommand`/`CutContentCommand`).
- هذه هي المادة التي تثبت أن المؤشر «يعمل بشكل صحيح» — كل الإصلاحات عرضية أو نطاقية.

---

## ٦. البناء والنشر

- **النسخة النشطة `univer-dev`**: خادم dev على `localhost:5173` (مجلد `examples`، وضع `bundledDev`). بعد أي تعديل مصدري: أعد تحميل الصفحة؛ وإن لاحظت chunk قديماً (أسماء/سلوك لا يطابق المصدر) أعد تشغيل الخادم: `cd ~/web/js/univer-dev/examples && npx vite --host 0.0.0.0`.
- **بناء الحزم (UMD)**: `bash /home/riyadh/web/js/build-univer-bundles.sh --repo <repo> --domain both --locales ar-SA,en-US --out <dir>`.
- **ملاحظة خط 1.0**: النشر UMD لخط 1.0 يتطلب `UniverDocsLayoutWorkerPlugin`.
- **أرشيف الكراك** (`web/js/crack/`): `univer-dev_1` = 21 ملفاً مطوَّراً بمساراتها (RTL + فايرفوكس + تحرير الهيدر/الفوتر) — التطبيق: نسخ المحتويات فوق جذر نسخة نظيفة من `univer-dev`.

---

## ٧. التحقق

- **اختبارات المعالج**: `rtl-processor.spec.ts` — إعادة ترتيب الجمل، أرقام/وقت داخل نص عربي، مراينة الأقواس، لام-ألف، ZWNJ. (مكتوب على واجهة v1 — يحتاج مواءمة v2 لاحقاً؛ لا يؤثر البناء/التشغيل.)
- **قياسات حية (الجلسة)**: سجلات إزاحة إدخال رتيبة في الهيدر عبر مسافات/Enter/عربي/لاتيني؛ فحص Enter يعيد `segmentId: "header-default"`؛ تحديد كلمة/Ctrl+A + حذف = بلا `ReferenceError`؛ صفر أخطاء صفحة في كل السيناريوهات (كروم headless بمحاكاة `ar-SA` + تأكيد المستخدم على فايرفوكس).
- **تأكيدات المستخدم الحية (سابقة)**: الترقيم ملتصق ✓، التضليل كتلة ✓، Backspace حرف واحد ✓، المؤشر يرث الاتجاه بعد Enter ✓.

---

## ٨. حدود معروفة وخطوات تالية

1. **Sheets RTL (قلب الأعمدة)**: `rightToLeft` config-only — يتطلب تنفيذاً في محرك عرض Sheets (أكبر قطعة متبقية).
2. **حقل اتجاه فقرة صريح** في نموذج Docs (امتداد اختياري للتحكم اليدوي الكامل).
3. **التفاف الرموز اللاتينية المحدّبة** (`-Manifold-Constrained`) عبر نهاية السطر — كسر أسطر معروف.
4. **مواءمة `rtl-processor.spec.ts`** مع واجهة v2.
5. **ب (جلسة — معروفة ومؤجلة)**: في الهيدر/الفوتر، تغيير تنسيق على **تحديد** (مثل حجم الخط من التولبار العلوي) لا يُعاد رسمه فوراً بل بعد الخروج من وضع الهيدر — أثر حصر deferral على المنهار في §٣.١٥؛ سيُعالج لاحقاً بآلية «تطبيق التحديد المعلّق عند اكتمال التخطيط» للمقاطع. (الكتابة نفسها فورية وسليمة.)
6. **تنظيف اختياري**: إزالة سجلي التشخيص المتبقيين `[fb]` (`font-and-base-line.ts`) و`[rtl-paint]` (`shape/text.ts`).
7. **الاستماع للكيبورد النشط** (`event.key`) كرفع فوري لاتجاه الفقرة في المستندات اللاتينية.
