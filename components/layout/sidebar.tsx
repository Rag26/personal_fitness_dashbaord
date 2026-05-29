"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Apple,
  Dumbbell,
  Gauge,
  Settings,
  TrendingUp,
} from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/today", label: "Today", icon: Gauge },
  { href: "/train", label: "Train", icon: Dumbbell },
  { href: "/nutrition", label: "Nutrition", icon: Apple },
  { href: "/progress", label: "Progress", icon: TrendingUp },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:bg-transparent">
      <div className="flex h-16 items-center px-6">
        <Link href="/today" className="text-lg font-semibold tracking-tight text-stone-900">
          LockIn<span className="text-stone-500">.</span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 pb-4 pt-2">
        {navItems.map((item) => {
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-all",
                active
                  ? "border border-[color:color-mix(in_srgb,var(--ui-accent)_32%,transparent)] bg-[color:var(--ui-accent-soft)] font-medium text-[color:var(--color-text-primary)] shadow-sm shadow-black/[0.04]"
                  : "border border-transparent text-[color:var(--color-text-tertiary)] hover:border-[color:color-mix(in_srgb,var(--ui-accent)_24%,transparent)] hover:bg-[color:var(--ui-accent-soft)] hover:text-[color:var(--color-text-secondary)]",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4",
                  active ? "text-[color:var(--ui-accent)]" : "",
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
