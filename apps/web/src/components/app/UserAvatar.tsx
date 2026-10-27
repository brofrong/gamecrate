// Круглый аватар пользователя для полоски и нижней панели `/app`: фото из профиля
// (Google/Yandex/Pocket ID), без фото — первая буква имени на фирменном градиенте.
// Декоративный: подпись даёт ссылка-родитель («Профиль»), `alt` пустой.
import type { CurrentUserShape } from "@cg/rpc";
import { avatarInitial } from "@/lib/accountDisplay";
import { cn } from "@/lib/utils";

export function UserAvatar({
  user,
  className,
}: {
  user: Pick<CurrentUserShape, "name" | "email" | "image">;
  /** Размер и прочее — от места: `size-10` в полоске, `size-6` во вкладке. */
  className?: string;
}) {
  if (user.image !== null && user.image !== "") {
    return (
      <img
        src={user.image}
        alt=""
        className={cn(
          "rounded-full object-cover ring-1 ring-white/10",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-full bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff] text-sm font-semibold text-[#eef1ff]",
        className,
      )}
    >
      {avatarInitial(user)}
    </span>
  );
}
