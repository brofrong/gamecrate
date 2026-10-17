// Сервер (api или RPC-сокет) не отвечает: сообщение и «Повторить».
import { CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ServerUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <CloudOff className="size-6" />
      </div>
      <p className="text-lg font-medium">Не удалось связаться с сервером</p>
      <p className="text-sm text-muted-foreground">
        Проверьте подключение к интернету и попробуйте ещё раз.
      </p>
      <Button onClick={onRetry}>
        <RefreshCw />
        Повторить
      </Button>
    </div>
  );
}
