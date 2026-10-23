// Карточка «Подключи Steam» для пользователя без привязанного Steam — без него
// библиотека недоступна. Копия `ConnectSteam` из `routes/library.tsx` (тот файл не
// трогаем, им владеет другой поток до переключения на `/app`) — те же тексты и кнопка.
import { Button } from "@/components/ui/button";

export function ConnectSteam({ onLink }: { onLink: () => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <p className="text-lg font-medium text-[#eef1ff]">
        Подключи Steam, чтобы увидеть свою библиотеку
      </p>
      <p className="text-sm text-[#8a90a8]">
        Мы не просим пароль: Steam сам подтвердит, что аккаунт твой
      </p>
      <Button onClick={onLink}>Привязать Steam</Button>
    </div>
  );
}
