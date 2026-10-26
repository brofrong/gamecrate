// Карточка для пользователя без привязанного Steam — без него библиотека недоступна.
// Кнопка открывает `SteamQrLogin` в модальном окне вместо старой OpenID-привязки.
// `QrLogin` — только для тестов (подмена настоящего компонента фейком).
import { useState } from "react";
import {
  SteamQrLogin,
  SteamQrLoginDialog,
  type SteamQrLoginComponent,
} from "@/components/SteamQrLogin";
import { Button } from "@/components/ui/button";

export function ConnectSteam({
  onDone,
  QrLogin = SteamQrLogin,
}: {
  onDone: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <p className="text-lg font-medium text-[#eef1ff]">Подключите Steam</p>
      <p className="text-sm text-[#8a90a8]">
        Мы не просим пароль: Steam сам подтвердит, что аккаунт твой
      </p>
      <Button onClick={() => setOpen(true)}>Подключить Steam</Button>
      <SteamQrLoginDialog
        open={open}
        title="Подключите Steam"
        onDone={() => {
          setOpen(false);
          onDone();
        }}
        onClose={() => setOpen(false)}
        QrLogin={QrLogin}
      />
    </div>
  );
}
