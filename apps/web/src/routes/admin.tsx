// `/admin`: админка (проверка связи, «Настройки сессий»). Без сессии — вход через Pocket ID,
// игрок — «Нет доступа».
import type { SessionSettings } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createRoute } from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type * as React from "react";
import { toast } from "sonner";
import { signInWithProvider } from "@/auth";
import { SessionSettingsForm } from "@/components/admin/SessionSettingsForm";
import { AppHeader } from "@/components/AppHeader";
import { FullscreenLoader } from "@/components/FullscreenLoader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  adminPingAtom,
  errorTag,
  meAtom,
  resultErrorTag,
  sessionSettingsAtom,
  updateSessionSettingsArgs,
  updateSessionSettingsAtom,
} from "@/rpc";
import { rootRoute } from "./__root";

function PocketIdButton({ variant }: { variant?: "default" | "outline" }) {
  return (
    <Button
      variant={variant}
      onClick={() => void signInWithProvider("pocket-id", "/admin")}
    >
      Войти через Pocket ID
    </Button>
  );
}

function CenteredCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children && (
          <CardContent className="flex justify-center">{children}</CardContent>
        )}
      </Card>
    </main>
  );
}

function NoAccess() {
  return (
    <CenteredCard
      title="Нет доступа"
      description="Админка доступна только администраторам."
    >
      <PocketIdButton variant="outline" />
    </CenteredCard>
  );
}

/** Текст ошибки сохранения настроек по `_tag` ошибки RPC. */
const saveError = (tag: string | undefined) =>
  tag === "Forbidden" || tag === "Unauthorized"
    ? "Нет прав на изменение настроек — войдите как администратор"
    : "Не удалось сохранить настройки. Сервер отклонил значения или недоступен.";

function SessionSettingsCard() {
  const settings = useAtomValue(sessionSettingsAtom);
  const update = useAtomSet(updateSessionSettingsAtom, {
    mode: "promiseExit",
  });

  const onSubmit = async (value: SessionSettings) => {
    const exit = await update(updateSessionSettingsArgs(value));
    if (Exit.isSuccess(exit)) {
      toast.success("Настройки сохранены");
      return null;
    }
    return saveError(errorTag(exit.cause));
  };

  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Настройки сессий</CardTitle>
        <CardDescription>
          Применяются сразу, в том числе к идущим сессиям.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {AsyncResult.match(settings, {
          onInitial: () => (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={`settings-${i}`} className="h-14 w-full" />
              ))}
            </div>
          ),
          onFailure: () => (
            <p className="text-sm text-destructive">
              Не удалось загрузить настройки
            </p>
          ),
          onSuccess: ({ value }) => (
            <SessionSettingsForm initial={value} onSubmit={onSubmit} />
          ),
        })}
      </CardContent>
    </Card>
  );
}

function AdminHome() {
  const me = useAtomValue(meAtom);
  const ping = useAtomValue(adminPingAtom);

  if (resultErrorTag(ping) === "Forbidden") return <NoAccess />;

  return (
    <div className="min-h-dvh">
      <AppHeader user={AsyncResult.isSuccess(me) ? me.value : undefined} />
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold">Админка</h1>
        <Card className="max-w-sm">
          <CardContent className="flex items-center gap-3">
            {AsyncResult.isFailure(ping) ? (
              <ShieldAlert className="size-5 text-destructive" />
            ) : (
              <ShieldCheck className="size-5 text-emerald-400" />
            )}
            <span className="text-sm">
              {AsyncResult.match(ping, {
                onInitial: () => "Проверяем связь с сервером…",
                onFailure: () => "Сервер не ответил на admin.ping",
                onSuccess: ({ value }) => `admin.ping: ${value}`,
              })}
            </span>
          </CardContent>
        </Card>
        <div className="mt-6">
          <SessionSettingsCard />
        </div>
      </main>
    </div>
  );
}

function AdminPage() {
  const me = useAtomValue(meAtom);

  if (AsyncResult.isInitial(me)) return <FullscreenLoader />;
  if (AsyncResult.isFailure(me)) {
    return resultErrorTag(me) === "Unauthorized" ? (
      <CenteredCard
        title="Админка"
        description="Войдите учётной записью администратора."
      >
        <PocketIdButton />
      </CenteredCard>
    ) : (
      <CenteredCard
        title="Админка"
        description="Не удалось связаться с сервером. Обновите страницу."
      />
    );
  }
  if (me.value.role !== "admin") return <NoAccess />;
  return <AdminHome />;
}

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});
