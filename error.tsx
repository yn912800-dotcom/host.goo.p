"use client";

import { useEffect } from "react";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep the boundary intentionally quiet in production; Next.js handles diagnostics server-side.
  }, []);

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <section className="card max-w-lg w-full p-8 text-center animate-fadein">
        <div className="text-6xl font-black text-red-400">500</div>
        <h1 className="mt-4 text-2xl font-bold">حدث خطأ غير متوقع</h1>
        <p className="mt-2 text-sm text-[color:var(--muted)]">لم نتمكن من إكمال الطلب. يمكنك المحاولة مرة أخرى.</p>
        <button type="button" onClick={() => reset()} className="btn btn-primary mt-6">إعادة المحاولة</button>
      </section>
    </main>
  );
}
