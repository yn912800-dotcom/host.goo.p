"use client";
import { createContext, useContext } from "react";

export type Locale = "en" | "ar";

export const translations = {
  en: {
    "nav.features": "Features",
    "nav.runtimes": "Runtimes",
    "nav.plans": "Plans",
    "nav.faq": "FAQ",
    "nav.login": "Log in",
    "nav.signup": "Get started",
    "nav.dashboard": "Dashboard",
    "nav.logout": "Log out",
    "hero.title": "Deploy any project in seconds.",
    "hero.subtitle":
      "A modern hosting platform for Python, Node.js, PHP and static sites. Upload your code, we handle the rest.",
    "hero.cta": "Start free",
    "hero.cta2": "See plans",
    "features.title": "Everything you need to ship.",
    "features.sub": "From upload to live URL — all in your browser.",
    "runtimes.title": "Supported runtimes",
    "plans.title": "Simple pricing",
    "plans.sub": "Choose the plan that fits your project.",
    "how.title": "How it works",
    "faq.title": "Frequently asked questions",
    "footer.rights": "All rights reserved.",
    "common.loading": "Loading...",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.create": "Create",
    "common.edit": "Edit",
    "common.search": "Search",
    "common.theme": "Theme",
    "common.language": "Language",
    "auth.email": "Email",
    "auth.password": "Password",
    "auth.name": "Full name",
    "auth.loginTitle": "Welcome back",
    "auth.loginSub": "Sign in to your account",
    "auth.signupTitle": "Create your account",
    "auth.signupSub": "Start deploying in minutes.",
    "auth.hasAccount": "Already have an account?",
    "auth.noAccount": "Don't have an account?",
  },
  ar: {
    "nav.features": "المميزات",
    "nav.runtimes": "المنصات",
    "nav.plans": "الباقات",
    "nav.faq": "الأسئلة",
    "nav.login": "تسجيل الدخول",
    "nav.signup": "ابدأ الآن",
    "nav.dashboard": "لوحة التحكم",
    "nav.logout": "تسجيل الخروج",
    "hero.title": "انشر مشروعك خلال ثوانٍ.",
    "hero.subtitle":
      "منصة استضافة حديثة لمشاريع Python و Node.js و PHP والمواقع الثابتة. ارفع الكود ونحن نهتم بالباقي.",
    "hero.cta": "ابدأ مجانًا",
    "hero.cta2": "عرض الباقات",
    "features.title": "كل ما تحتاجه للنشر.",
    "features.sub": "من الرفع حتى التشغيل — كل شيء من المتصفح.",
    "runtimes.title": "البيئات المدعومة",
    "plans.title": "باقات بسيطة",
    "plans.sub": "اختر الباقة المناسبة لمشروعك.",
    "how.title": "كيف يعمل",
    "faq.title": "الأسئلة الشائعة",
    "footer.rights": "جميع الحقوق محفوظة.",
    "common.loading": "جارٍ التحميل...",
    "common.save": "حفظ",
    "common.cancel": "إلغاء",
    "common.delete": "حذف",
    "common.create": "إنشاء",
    "common.edit": "تعديل",
    "common.search": "بحث",
    "common.theme": "المظهر",
    "common.language": "اللغة",
    "auth.email": "البريد الإلكتروني",
    "auth.password": "كلمة المرور",
    "auth.name": "الاسم الكامل",
    "auth.loginTitle": "أهلاً بعودتك",
    "auth.loginSub": "سجّل الدخول إلى حسابك",
    "auth.signupTitle": "أنشئ حسابك",
    "auth.signupSub": "ابدأ النشر خلال دقائق.",
    "auth.hasAccount": "لديك حساب بالفعل؟",
    "auth.noAccount": "ليس لديك حساب؟",
  },
} as const;

type Dict = typeof translations.en;
export type TKey = keyof Dict;

export const I18nContext = createContext<{
  locale: Locale;
  t: (k: TKey) => string;
  setLocale: (l: Locale) => void;
}>({
  locale: "ar",
  t: (k) => k,
  setLocale: () => {},
});

export function useI18n() {
  return useContext(I18nContext);
}
