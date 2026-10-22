// Отображаемое имя и буква для аватара без фото: шапка и блок «Аккаунт» в профиле
// используют один и тот же фолбэк — пустое имя (код на почту до смокового фикса
// не спрашивал имя) не должно превращаться в пустой кружок/подпись.
import type { CurrentUserShape } from "@cg/rpc";

type NameAndEmail = Pick<CurrentUserShape, "name" | "email">;

/** Имя пользователя: `name`, иначе локальная часть почты, иначе «?». */
export const displayName = (user: NameAndEmail): string => {
  const name = user.name.trim();
  if (name) return name;
  const local = user.email?.trim().split("@")[0]?.trim();
  return local && local.length > 0 ? local : "?";
};

/** Первая буква `displayName` в верхнем регистре — для круглого аватара без фото. */
export const avatarInitial = (user: NameAndEmail): string =>
  displayName(user).slice(0, 1).toUpperCase();
