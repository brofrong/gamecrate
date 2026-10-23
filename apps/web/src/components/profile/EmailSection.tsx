// Раздел почты в профиле: показывает адрес, добавляет/меняет его кодом на новый адрес.
import { useState } from "react";
import type { CurrentUserShape } from "@cg/rpc";
import { confirmEmailChange, requestEmailChange } from "@/auth";
import { Button } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/authErrors";

type Step =
  | { kind: "view" }
  | { kind: "email"; value: string }
  | { kind: "code"; email: string; otp: string };

export function EmailSection({
  user,
  onChanged,
}: {
  user: CurrentUserShape;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "view" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async (email: string) => {
    setPending(true);
    setError(null);
    const { error } = await requestEmailChange(email);
    setPending(false);
    if (error) {
      setError(authErrorMessage(error.code ?? "UNKNOWN"));
      return;
    }
    setStep({ kind: "code", email, otp: "" });
  };

  const confirmCode = async (email: string, otp: string) => {
    setPending(true);
    setError(null);
    const { error } = await confirmEmailChange(email, otp);
    setPending(false);
    if (error) {
      setError(authErrorMessage(error.code ?? "UNKNOWN"));
      return;
    }
    setStep({ kind: "view" });
    onChanged();
  };

  const handleCodeChange = (email: string, value: string) => {
    const otp = value.replace(/\D/g, "").slice(0, 6);
    setError(null);
    setStep({ kind: "code", email, otp });
    if (otp.length === 6) void confirmCode(email, otp);
  };

  if (step.kind === "view") {
    return (
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Почта</h2>
        <p className="text-sm text-muted-foreground">
          {user.email ?? "Почта не добавлена"}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => setStep({ kind: "email", value: "" })}
        >
          {user.email === null ? "Добавить почту" : "Сменить почту"}
        </Button>
      </section>
    );
  }

  if (step.kind === "email") {
    return (
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Почта</h2>
        <form
          className="grid max-w-sm gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void requestCode(step.value);
          }}
        >
          <input
            type="email"
            placeholder="новая почта"
            aria-label="Новая почта"
            value={step.value}
            disabled={pending}
            onChange={(e) => {
              setError(null);
              setStep({ kind: "email", value: e.target.value });
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            size="sm"
            disabled={pending || step.value.trim().length === 0}
            className="justify-self-start"
          >
            Отправить код
          </Button>
        </form>
      </section>
    );
  }

  return (
    <section className="grid gap-2">
      <h2 className="text-lg font-semibold">Почта</h2>
      <p className="text-sm text-muted-foreground">
        Код отправлен на {step.email}
      </p>
      <input
        type="text"
        inputMode="numeric"
        maxLength={6}
        autoComplete="one-time-code"
        aria-label="Код из письма"
        disabled={pending}
        value={step.otp}
        onChange={(e) => handleCodeChange(step.email, e.target.value)}
        className="h-10 max-w-40 rounded-md border bg-background px-3 text-center font-mono text-lg tracking-[0.3em] outline-none focus-visible:border-ring"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
