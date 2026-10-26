// Шапка для вошедшего пользователя: название, ссылки, аватар и «Выйти».
import type { CurrentUserShape } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import type * as React from "react";
import { signOut } from "@/auth";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { avatarInitial } from "@/lib/accountDisplay";

export function AppHeader({
  user,
  children,
}: {
  user: CurrentUserShape | undefined;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-4 px-4 sm:px-6">
        <Link to="/app" className="flex items-center gap-2 font-semibold">
          <Logo iconOnly height={28} />
          <span className="hidden sm:inline">GameCrate</span>
        </Link>
        {user?.role === "admin" && (
          <Link
            to="/admin"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Админка
          </Link>
        )}
        <div className="ml-auto flex items-center gap-3">
          {children}
          {user && (
            <Link
              to="/profile"
              aria-label="Профиль"
              className="flex items-center gap-2 rounded-md hover:opacity-80"
            >
              {user.image ? (
                <img
                  src={user.image}
                  alt=""
                  className="size-8 rounded-full ring-1 ring-white/10"
                />
              ) : (
                <div className="flex size-8 items-center justify-center rounded-full bg-muted text-sm">
                  {avatarInitial(user)}
                </div>
              )}
              <span className="hidden max-w-40 truncate text-sm md:inline">
                {user.name}
              </span>
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOut />
            Выйти
          </Button>
        </div>
      </div>
    </header>
  );
}
