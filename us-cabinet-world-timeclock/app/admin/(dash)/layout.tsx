import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { logoutAction } from "../actions";

export const metadata = { title: "Admin · US Cabinet World Time Clock" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireAdmin();
  const links: { href: string; label: string; adminOnly?: boolean }[] = [
    { href: "/admin", label: "Status" },
    { href: "/admin/review", label: "Review" },
    { href: "/admin/timecards", label: "Timecards" },
    { href: "/admin/settlement", label: "Settlement", adminOnly: true },
    { href: "/admin/employees", label: "Employees", adminOnly: true },
    { href: "/admin/settings", label: "Settings", adminOnly: true },
    { href: "/admin/audit", label: "Audit log", adminOnly: true },
  ];
  return (
    <div className="min-h-dvh">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div>
            <p className="font-bold">US Cabinet World · Time Clock Admin</p>
            <p className="text-xs text-slate-300">
              {user.display_name} ({user.role})
            </p>
          </div>
          <form action={logoutAction}>
            <button className="rounded-lg border border-slate-500 px-3 py-1 text-sm hover:bg-slate-800">Sign out</button>
          </form>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2 pb-2 text-sm">
          {links
            .filter((l) => !l.adminOnly || user.role === "admin")
            .map((l) => (
              <Link key={l.href} href={l.href} className="rounded-md px-3 py-1.5 whitespace-nowrap hover:bg-slate-700">
                {l.label}
              </Link>
            ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
