import { useMemo } from "react";
import { LeafIcon, ReturnIcon, ShipIcon, StarIcon } from "../components/ui/Icons";
import LinkButton from "../components/ui/LinkButton";
import ProductPhoto from "../components/ui/ProductPhoto";
import Reveal from "../components/ui/Reveal";
import { useLanguage } from "../context/LanguageContext";

const VALUES_EN = [
  {
    icon: LeafIcon,
    title: "Better fabrics, always",
    body: "Recycled fibers, organic cotton, and responsibly sourced materials in every drop — no exceptions.",
  },
  {
    icon: ReturnIcon,
    title: "Built to be worn out",
    body: "Every style survives a wash-and-wear stress test before it ships. If it pills or fades early, we redesign it.",
  },
  {
    icon: StarIcon,
    title: "Fit for real bodies",
    body: "Sized on real fit models across our full size range, not one sample body scaled up and down.",
  },
  {
    icon: ShipIcon,
    title: "Fast, fair, transparent",
    body: "Real shipping timelines, real return windows, and a support team that actually answers.",
  },
];

const VALUES_AR = [
  {
    icon: LeafIcon,
    title: "أقمشة أفضل، دائماً",
    body: "ألياف معاد تدويرها، قطن عضوي، وخامات مصدرها مسؤول في كل إصدار — دون استثناء.",
  },
  {
    icon: ReturnIcon,
    title: "مصممة لتدوم مع الاستخدام",
    body: "كل تصميم يجتاز اختبار تحمل صارم للغسل والارتداء قبل شحنه. وإذا تآكل أو بهت لونه مبكراً، نعيد تصميمه.",
  },
  {
    icon: StarIcon,
    title: "مقاسات لأجسام حقيقية",
    body: "مقاساتنا مأخوذة من عارضات حقيقيات ضمن نطاق مقاساتنا الكامل، وليس من جسد نموذجي واحد يُكبَّر ويُصغَّر.",
  },
  {
    icon: ShipIcon,
    title: "سريعة، عادلة، وشفافة",
    body: "مواعيد شحن حقيقية، فترات إرجاع حقيقية، وفريق دعم يستجيب فعلاً.",
  },
];

const STEPS_EN = [
  { n: "01", title: "Sketch to sample", body: "Every piece starts as a fit problem — how do we cut fabric that holds its shape through a full day." },
  { n: "02", title: "Fit-tested, three times", body: "Three full rounds of fit testing on real bodies before a style ever gets a product photo." },
  { n: "03", title: "Small first runs", body: "We launch in small batches so we're never sitting on dead stock, and never rushing a bad fit to market." },
  { n: "04", title: "Restocked on repeat", body: "Bestsellers get restocked, not reinvented. If it works, we keep making it." },
];

const STEPS_AR = [
  { n: "01", title: "من الرسم إلى النموذج", body: "كل قطعة تبدأ كمعضلة قصّة — كيف نقصّ القماش بطريقة تحافظ على شكله طوال اليوم." },
  { n: "02", title: "اختبار القصّة ثلاث مرات", body: "ثلاث جولات كاملة من اختبار القصّة على أجساد حقيقية قبل أن يُلتقط أي تصميم في صورة المنتج." },
  { n: "03", title: "إصدارات أولى محدودة", body: "نطلق تصاميمنا بدفعات صغيرة حتى لا نتكدس بمخزون راكد، ولا نتسرع بطرح قصّة غير مثالية في السوق." },
  { n: "04", title: "إعادة تخزين مستمرة", body: "القطع الأكثر مبيعاً تُعاد إلى المخزون كما هي دون تغيير. إن كانت ناجحة، نستمر في صنعها." },
];

const STATS_EN = [
  { value: "12k+", label: "Happy customers" },
  { value: "4.8/5", label: "Average rating" },
  { value: "27", label: "Core styles" },
  { value: "30-day", label: "Easy returns" },
];

const STATS_AR = [
  { value: "+12k", label: "عميلة سعيدة" },
  { value: "4.8/5", label: "متوسط التقييم" },
  { value: "27", label: "تصميماً أساسياً" },
  { value: "30 يوم", label: "إرجاع سهل" },
];

export default function About() {
  const { lang, t } = useLanguage();
  const VALUES = useMemo(() => (lang === "ar" ? VALUES_AR : VALUES_EN), [lang]);
  const STEPS = useMemo(() => (lang === "ar" ? STEPS_AR : STEPS_EN), [lang]);
  const STATS = useMemo(() => (lang === "ar" ? STATS_AR : STATS_EN), [lang]);

  return (
    <div>
      <section className="container-page pt-12 md:pt-20">
        <Reveal className="max-w-2xl">
          <span className="inline-flex rounded-full bg-sand px-4 py-2 text-sm font-bold uppercase tracking-wide text-wine-dark">
            {t("about.badge")}
          </span>
          <h1 className="mt-5 text-balance font-display text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            {t("about.title")}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-ink-soft">{t("about.intro")}</p>
        </Reveal>

        <Reveal delay={0.15} className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4 md:mt-16">
          <ProductPhoto imageId="1619794724492-651397287d94" alt="Dresses" width={400} aspect={{ w: 1, h: 1 }} className="aspect-square rounded-2xl" />
          <ProductPhoto imageId="1648066380643-675d30c3cd17" alt="Outerwear" width={400} aspect={{ w: 1, h: 1 }} className="mt-6 aspect-square rounded-2xl" />
          <ProductPhoto imageId="1732708872490-a1ff3a917047" alt="Knitwear" width={400} aspect={{ w: 1, h: 1 }} className="aspect-square rounded-2xl" />
          <ProductPhoto imageId="1625899845678-3fad6a4a1846" alt="Accessories" width={400} aspect={{ w: 1, h: 1 }} className="mt-6 aspect-square rounded-2xl" />
        </Reveal>
      </section>

      {/* Stats */}
      <section className="mt-16 border-y border-line bg-paper md:mt-24">
        <div className="container-page grid grid-cols-2 gap-8 py-10 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <p className="font-display text-2xl font-semibold text-wine sm:text-3xl">{s.value}</p>
              <p className="mt-1 text-sm text-ink-soft sm:text-base">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Values */}
      <section className="container-page py-16 md:py-24">
        <Reveal className="text-center">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("about.standFor")}</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">{t("about.standForSub")}</p>
        </Reveal>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
          {VALUES.map((v, i) => (
            <Reveal key={v.title} delay={i * 0.08}>
              <div className="flex h-full gap-4 rounded-2xl bg-paper p-6 shadow-soft">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sand sm:h-14 sm:w-14">
                  <v.icon className="h-5 w-5 text-wine-dark sm:h-7 sm:w-7" />
                </div>
                <div>
                  <h3 className="font-display text-xl font-semibold text-ink">{v.title}</h3>
                  <p className="mt-1.5 text-base leading-relaxed text-ink-soft">{v.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Process */}
      <section className="bg-wine py-16 text-on-accent md:py-24">
        <div className="container-page">
          <Reveal>
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("about.howMade")}</h2>
          </Reveal>
          <div className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.1}>
                <p className="font-display text-3xl font-semibold text-on-accent/40">{s.n}</p>
                <h3 className="mt-3 font-display text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-on-accent/65">{s.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="container-page py-16 text-center md:py-24">
        <Reveal>
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{t("about.comeSee")}</h2>
          <p className="mx-auto mt-3 max-w-md text-ink-soft">{t("about.comeSeeSub")}</p>
          <LinkButton to="/shop" size="lg" className="mt-8">
            {t("about.shopCollection")}
          </LinkButton>
        </Reveal>
      </section>
    </div>
  );
}
