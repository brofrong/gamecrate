// Блок «Аккаунт» профиля (§5.1 спеки): аватар и имя, выше раздела почты
// (`EmailSection` остаётся единственным владельцем самой почты).
import type { CurrentUserShape } from "@cg/rpc";
import { avatarInitial, displayName } from "@/lib/accountDisplay";

export function AccountSummary({ user }: { user: CurrentUserShape }) {
  return (
    <section className="flex items-center gap-3">
      {user.image ? (
        <img
          src={user.image}
          alt=""
          className="size-14 rounded-full ring-1 ring-white/10"
        />
      ) : (
        <div className="flex size-14 items-center justify-center rounded-full bg-muted text-lg">
          {avatarInitial(user)}
        </div>
      )}
      <p className="text-lg font-medium">{displayName(user)}</p>
    </section>
  );
}
