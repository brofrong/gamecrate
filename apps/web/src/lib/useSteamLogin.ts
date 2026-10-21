// Вход через Steam с лендинга: `pending` на время запроса; при успехе клиент Better Auth
// сам уводит браузер на steamcommunity.com, при ошибке — тост и кнопка снова активна.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { signInWithSteam } from "@/auth";

export const steamLoginFailed =
  "Не удалось войти через Steam. Попробуйте ещё раз.";

export function useSteamLogin(): { login: () => void; pending: boolean } {
  const [pending, setPending] = useState(false);

  const login = useCallback(() => {
    setPending(true);
    void signInWithSteam()
      .catch(() => ({ error: true }))
      .then((result) => {
        if (result.error) {
          setPending(false);
          toast.error(steamLoginFailed);
        }
      });
  }, []);

  return { login, pending };
}
