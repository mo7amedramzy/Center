# مَركز | إدارة السنتر التعليمي

تطبيق عربي RTL لإدارة المدرسين والمجموعات والطلاب والحضور. الواجهة مبنية بـ React وVite داخل `frontend/`، وواجهة API بـ Express 5 داخل `backend/`، وقاعدة البيانات PostgreSQL. يتصل الخادم بـ Neon عبر `pg`.

## التشغيل المحلي

1. أنشئ قاعدة PostgreSQL (Neon مناسب للتطوير) وانسخ `.env.example` إلى `.env`.
2. ضع رابط قاعدة البيانات في `DATABASE_URL`، واضبط `JWT_SECRET` و`ADMIN_PASSWORD`.
3. شغّل:

```powershell
npm.cmd install
npm.cmd run dev
```

افتح `http://localhost:5173`. يُنشئ أول تشغيل حساب مدير باسم `ADMIN_USERNAME` وكلمة مرور `ADMIN_PASSWORD`، أو `admin` و`markaz123` في التطوير فقط عند عدم تحديدهما. لا يُعاد تعيين كلمة مرور حساب موجود. بيانات المدرسين والطلاب التجريبية تُنشأ تلقائيًا في `development` فقط، وعندما تكون جداولها فارغة؛ لا تُنشأ في الإنتاج أو الاختبارات.

لا تضع `DATABASE_URL` أو `JWT_SECRET` أو كلمات المرور في Git أو في متغيرات Vite. يستخدم الواجهة `VITE_API_URL` وقت البناء؛ والقيمة الافتراضية محليًا هي `/api` مع proxy إلى خادم التطوير.

## SQLite إلى PostgreSQL

توجد أداة نقل منفصلة في `backend/scripts/migrate-sqlite-to-postgres.js`. تفتح SQLite للقراءة فقط، ولا تحذف الملف الأصلي أو تعدله. تنقل الجداول بترتيب يحافظ على العلاقات، ضمن معاملة PostgreSQL واحدة، ثم تتحقق من عدد الصفوف وتضبط identity sequences.

الأداة ترفض قاعدة وجهة تحتوي أي صفوف في جداول التطبيق، لتجنب دمج مكرر أو الكتابة فوق بيانات. شغّلها **قبل أول تشغيل لخادم الإنتاج** (لأن الخادم ينشئ حساب المدير)، وعلى نسخة احتياطية من PostgreSQL وملف SQLite:

```powershell
$env:DATABASE_URL = "YOUR_NEON_CONNECTION_STRING"
npm.cmd install
npm.cmd --workspace backend run migrate:sqlite -- ..\data\center.sqlite
```

المسار الأخير يُفسر من مجلد `backend/`. غيّره إلى مسار ملف SQLite الفعلي، ولا تضع رابط قاعدة البيانات في ملف أو سجل مشترك. يعلن الأمر عدد الصفوف لكل جدول ولا يعتبر النقل ناجحًا إذا وقع خطأ. إذا لم يتوفر ملف SQLite، اترك النقل واستخدم تهيئة المخطط عند أول تشغيل، ثم أنشئ حساب المدير باستخدام متغيرات البيئة.

ينقل الأمر حسابات المستخدمين وكلمات مرورها المشفرة كما هي. ملف SQLite الموجود حاليًا يستخدم كلمة مرور المدير التطويرية؛ لن يستبدل الخادم كلمة مرور حساب مستورد تلقائيًا حتى عند ضبط `ADMIN_PASSWORD`. غيّرها صراحةً قبل إتاحة التطبيق للعامة بتعيين `DATABASE_URL` و`ADMIN_USERNAME` و`ADMIN_PASSWORD` الآمنة في البيئة ثم تشغيل `npm.cmd --workspace backend run admin:password`. لا تحفظ قيم الأسرار في المستودع أو سجل الأوامر.

## إعدادات الخادم

المتغيرات المطلوبة:

```text
NODE_ENV=production
DATABASE_URL=YOUR_NEON_CONNECTION_STRING
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YOUR_STRONG_PASSWORD
JWT_SECRET=YOUR_STRONG_RANDOM_SECRET
FRONTEND_URL=https://YOUR_PROJECT.vercel.app
```

`DATABASE_URL` مطلوب دائمًا. يستخدم الاتصال TLS تلقائيًا لمضيف Neon، ويُسمح بـ `sslmode=disable` للتطوير المحلي عند الحاجة. يلزم `ADMIN_PASSWORD` فقط إذا كان حساب المدير المحدد غير موجود بعد؛ إنشاء الحساب متكرر بأمان ولا يغيّر كلمة مرور حساب قائم. لا توجد بيانات تجريبية في الإنتاج.

## النشر على Render (Backend)

1. أنشئ قاعدة Neon وانسخ رابط الاتصال pooled أو direct مع TLS.
2. في Render أنشئ Web Service من المستودع، وحدد **Root Directory** إلى `backend`.
3. استخدم **Build Command** `npm install` و**Start Command** `npm start`.
4. أضف متغيرات الخادم أعلاه في لوحة Render، مع رابط Neon وسرّين قويين. بعد نشر الواجهة، اضبط `FRONTEND_URL` على أصل Vercel الدقيق، مثل `https://your-project.vercel.app`؛ يمكن فصل أكثر من أصل بفواصل. لا تستخدم `*` مع CORS.
5. استخدم `/api/health` كـ Health Check Path. يعيد `503` إذا تعذر الاتصال بـ PostgreSQL.
6. إن كنت تنقل SQLite، نفّذ أداة النقل على قاعدة Neon الفارغة قبل أول تشغيل للخادم. لا تشغّل الخدمة أولًا ثم تحاول نقل البيانات إلى قاعدة تحتوي حساب المدير.

## النشر على Vercel (Frontend)

1. أنشئ مشروع Vercel من المستودع وحدد **Root Directory** إلى `frontend`.
2. استخدم **Build Command** `npm run build` و**Output Directory** `dist`.
3. أضف متغير البناء `VITE_API_URL=https://YOUR_RENDER_SERVICE.onrender.com/api`، ثم أعد البناء والنشر.
4. ارجع إلى Render واضبط `FRONTEND_URL` على أصل Vercel الفعلي ثم أعد نشر Backend.

## الاختبارات والبناء

يتطلب اختبار تكامل PostgreSQL قاعدة اختبار مخصصة، لتجنب الكتابة إلى قاعدة الإنتاج. عيّن `TEST_DATABASE_URL` إلى قاعدة اختبار يمكن تعديلها، ثم شغّل:

```powershell
npm.cmd test
npm.cmd run build
```

عند غياب `TEST_DATABASE_URL` ستُعلَن اختبارات التكامل صراحةً على أنها غير مشغلة؛ لا يعني ذلك نجاح اختبار PostgreSQL.

## البيانات والصلاحيات

تسجيل الدخول يدعم المدير والمدرس. تبقى عمليات الطلاب والمجموعات والتسجيل والحضور ضمن صلاحيات الحساب، ويُحذف الطالب وحضوره وتسجيلاته عند حذفه. حذف المدرس يزيل مجموعاته وحضورها، ويحذف الطالب فقط إذا لم يكن مسجلًا لدى مدرس آخر. استيراد Excel يقبل حتى 500 طالب في معاملة واحدة.
