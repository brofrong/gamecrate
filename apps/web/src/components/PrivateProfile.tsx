// Экран для приватного профиля Steam: как открыть «Сведения об играх».
import { ExternalLink, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const STEAM_PRIVACY_URL = "https://steamcommunity.com/my/edit/settings";

export function PrivateProfile({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <Card className="mx-auto mt-10 max-w-xl">
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <Lock className="size-5" />
        </div>
        <CardTitle className="text-xl">Откройте „Сведения об играх“</CardTitle>
        <CardDescription>
          Профиль Steam скрывает список игр, поэтому мы не можем показать вашу
          библиотеку.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Откройте{" "}
            <a
              href={STEAM_PRIVACY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              настройки приватности Steam
              <ExternalLink className="size-3.5" />
            </a>
            .
          </li>
          <li>
            В пункте «Сведения об играх» выберите «Открытый» — настройка
            сохранится сама.
          </li>
          <li>Вернитесь сюда и нажмите «Обновить».</li>
        </ol>
        <Button
          onClick={onRefresh}
          disabled={refreshing}
          className="self-start"
        >
          Обновить
        </Button>
      </CardContent>
    </Card>
  );
}
