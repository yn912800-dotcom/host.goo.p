"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  Server,
  Bell,
  Settings,
  LogOut,
  Menu,
  X,
  Moon,
  Sun,
  Languages,
  Shield,
  Plus,
  User2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleTheme } from "@/components/providers";
import { useI18n } from "@/lib/i18n";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/servers", label: "My Servers", icon: Server },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default function DashboardShell({
  user,
  children,
}: {
  user: { id: string; name: string; email: string; role: string; avatarUrl: string | null };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isDark, setDark] = useState(true);
  const { locale, setLocale } = useI18n();

  useEffect(() => {
    setDark(!document.documentElement.classList.contains("light"));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed md:static inset-y-0 start-0 z-40 w-64 border-e border-[color:var(--border)] bg-[color:var(--card)] transition-transform",
          open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          "[dir=rtl]_&:translate-x-0"
        )}
      >
        <div className="h-16 flex items-center justify-between px-5 border-b border-[color:var(--border)]">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold">
            <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-xs">
              A
            </span>
            •-تــيــ۾ إڪـXـس-•
          </Link>
          <button className="md:hidden btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
        <nav className="p-3 space-y-1">
          {nav.map((n) => {
            const active = pathname === n.href || (n.href !== "/dashboard" && pathname.startsWith(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition",
                  active
                    ? "bg-indigo-500/10 text-indigo-300 border border-indigo-500/30"
                    : "text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/5"
                )}
              >
                <n.icon size={16} />
                {n.label}
              </Link>
            );
          })}
          {(user.role === "ADMIN" || user.role === "SUPER_ADMIN") && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:bg-white/5 mt-4"
            >
              <Shield size={16} />
              Admin panel
            </Link>
          )}
        </nav>
        <div className="absolute bottom-0 inset-x-0 p-3 border-t border-[color:var(--border)]">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-9 h-9 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 text-sm font-semibold">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user.name}</div>
              <div className="text-xs text-[color:var(--muted)] truncate">
                {user.email}
              </div>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full btn btn-ghost btn-sm justify-start mt-1"
          >
            <LogOut size={14} /> Log out
          </button>
        </div>
      </aside>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 h-16 border-b border-[color:var(--border)] bg-[color:var(--bg)]/80 backdrop-blur-md flex items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-3">
            <button
              className="md:hidden btn btn-ghost btn-sm"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard/servers/new" className="btn btn-primary btn-sm">
              <Plus size={14} /> <span className="hidden sm:inline">New project</span>
            </Link>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                toggleTheme();
                setDark(!document.documentElement.classList.contains("light"));
              }}
              aria-label="Theme"
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
              aria-label="Language"
            >
              <Languages size={16} />
            </button>
            <Link href="/dashboard/settings" className="btn btn-ghost btn-sm" aria-label="Profile">
              <User2 size={16} />
            </Link>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6 scrollbar">{children}</main>
      </div>
    </div>
  );
}
