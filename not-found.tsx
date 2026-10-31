import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <section className="card max-w-lg w-full p-8 text-center animate-fadein">
        <div className="text-6xl font-black gradient-text">404</div>
        <h1 className="mt-4 text-2xl font-bold">الصفحة غير موجودة</h1>
        <p className="mt-2 text-sm text-[color:var(--muted)]">الرابط الذي طلبته غير متاح أو تم نقله.</p>
        <Link href="/" className="btn btn-primary mt-6">العودة إلى الرئيسية</Link>
      </section>
    </main>
  );
}
