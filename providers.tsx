"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I18nContext, type Locale, translations, type TKey } from "@/lib/i18n";

export function Providers({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("ar");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const l = (localStorage.getItem("locale") as Locale) || "ar";
    setLocaleState(l);
    document.documentElement.setAttribute("lang", l);
    document.documentElement.setAttribute("dir", l === "ar" ? "rtl" : "ltr");
    setMounted(true);
    // Register SW
    if ("serviceWorker" in navigator && window.location.protocol === "https:") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  const setLocale = (l: Locale) => {
    localStorage.setItem("locale", l);
    setLocaleState(l);
    document.documentElement.setAttribute("lang", l);
    document.documentElement.setAttribute("dir", l === "ar" ? "rtl" : "ltr");
  };

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t: (k: TKey) => (translations[locale] as Record<string, string>)[k] ?? k,
    }),
    [locale]
  );

  return (
    <I18nContext.Provider value={value}>
      <div style={{ visibility: mounted ? "visible" : "hidden" }}>{children}</div>
    </I18nContext.Provider>
  );
}

export function toggleTheme() {
  const root = document.documentElement;
  if (root.classList.contains("light")) {
    root.classList.remove("light");
    root.classList.add("dark");
    localStorage.setItem("theme", "dark");
  } else {
    root.classList.remove("dark");
    root.classList.add("light");
    localStorage.setItem("theme", "light");
  }
}
