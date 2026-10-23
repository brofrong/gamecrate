// Правая панель страницы входа: кнопки провайдеров, вход по одноразовому коду на почту,
// скелетон до загрузки списка провайдеров, репортит сцене слева уровень сборки, подсветку
// провайдера и момент успешного входа («зажигание» куба).
import { useEffect, useRef, useState } from "react";
import type { AuthProviders } from "@cg/rpc";
import { sendEmailCode, signInWithEmailCode, signInWithProvider } from "@/auth";
import { Button } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/authErrors";
import { assemblyLevel, type Level, PROVIDER_TINT } from "@/lib/cubeAssembly";
import { ProviderButtons } from "./ProviderButtons";

export type PanelStep =
  | { kind: "email"; email: string }
  | { kind: "code"; email: string; otp: string; resendAt: number };

type Provider = "yandex" | "google" | "telegram";

/** Сколько ждать до повторной отправки письма с кодом. */
const RESEND_MS = 30_000;

export function LoginPanel({
  providers,
  next,
  onLevel,
  onTint,
  onLit,
}: {
  providers: AuthProviders | undefined;
  next: string;
  onLevel: (l: Level) => void;
  onTint: (t: keyof typeof PROVIDER_TINT | null) => void;
  onLit: () => void;
}) {
  const [step, setStep] = useState<PanelStep>({ kind: "email", email: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const autoSubmitted = useRef<string | null>(null);

  const requestCode = async (email: string) => {
    setPending(true);
    setError(null);
    const result = await sendEmailCode(email);
    setPending(false);
    if (result.error) {
      setError(authErrorMessage(result.error));
      return;
    }
    autoSubmitted.current = null;
    setStep({
      kind: "code",
      email,
      otp: "",
      resendAt: Date.now() + RESEND_MS,
    });
  };

  const submitCode = async (email: string, otp: string) => {
    setPending(true);
    setError(null);
    const result = await signInWithEmailCode(email, otp);
    setPending(false);
    if (result.error) {
      setError(authErrorMessage(result.error));
      return;
    }
    onLit();
    window.location.assign(next);
  };

  const handleProvider = (p: Provider) => {
    setSubmitted(true);
    onLit();
    void signInWithProvider(p, next);
  };

  const changeEmail = () => {
    setError(null);
    setSubmitted(false);
    setStep((s) => ({ kind: "email", email: s.email }));
  };

  const handleCodeChange = (value: string) => {
    const otp = value.replace(/\D/g, "").slice(0, 6);
    setError(null);
    setStep((s) => (s.kind === "code" ? { ...s, otp } : s));
  };

  // Таймер «Отправить ещё раз»: тикает только на шаге кода.
  useEffect(() => {
    if (step.kind !== "code") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step.kind]);

  // Уровень сборки куба — чистая функция от текущего состояния формы.
  useEffect(() => {
    const codeLength = step.kind === "code" ? step.otp.length : 0;
    onLevel(assemblyLevel({ email: step.email, codeLength, submitted }));
    // onLevel стабильна по контракту пропа — в зависимости не включаем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, submitted]);

  // Автоподтверждение по 6-й цифре — ровно один раз на каждый введённый код.
  useEffect(() => {
    if (step.kind !== "code" || step.otp.length !== 6) return;
    if (autoSubmitted.current === step.otp) return;
    autoSubmitted.current = step.otp;
    void submitCode(step.email, step.otp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (providers === undefined) {
    return (
      <div
        role="status"
        aria-label="Загрузка способов входа"
        className="grid w-full max-w-sm gap-2.5"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-xl bg-white/6" />
        ))}
      </div>
    );
  }

  // Разделитель «или по почте» имеет смысл только когда выше есть хотя бы одна
  // кнопка провайдера (pocketId сюда не входит — это отдельная «Вход для команды»).
  const hasProviderButtons = Boolean(
    providers.google || providers.yandex || providers.telegram,
  );
  const canResend = now >= (step.kind === "code" ? step.resendAt : 0);
  const remaining =
    step.kind === "code"
      ? Math.max(0, Math.ceil((step.resendAt - now) / 1000))
      : 0;

  return (
    <div className="grid w-full max-w-sm gap-5">
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-brand-text">
        Войти в GameCrate
      </h1>

      {step.kind === "email" ? (
        <>
          <ProviderButtons
            providers={providers}
            onProvider={handleProvider}
            onHover={onTint}
            pending={pending}
          />
          {hasProviderButtons && (
            <div className="flex items-center gap-3 text-xs text-brand-muted">
              <span className="h-px flex-1 bg-brand-line" />
              или по почте
              <span className="h-px flex-1 bg-brand-line" />
            </div>
          )}
          <form
            className="grid gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void requestCode(step.email);
            }}
          >
            <input
              type="email"
              placeholder="почта"
              aria-label="Почта"
              value={step.email}
              disabled={pending}
              onChange={(e) => {
                setError(null);
                setStep({ kind: "email", email: e.target.value });
              }}
              className="h-11 rounded-xl border border-white/12 bg-white/6 px-4 text-sm text-brand-text outline-none placeholder:text-brand-muted focus-visible:border-brand-cyan"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button
              type="submit"
              disabled={pending || step.email.trim().length === 0}
              className="h-11 w-full rounded-xl bg-brand-gradient text-sm font-semibold text-white"
            >
              Получить код
            </Button>
          </form>
        </>
      ) : (
        <div className="grid gap-2.5">
          <p className="text-sm text-brand-muted">
            Код отправлен на {step.email}{" "}
            <Button
              type="button"
              variant="link"
              onClick={changeEmail}
              className="h-auto p-0 text-brand-cyan"
            >
              Изменить
            </Button>
          </p>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            autoComplete="one-time-code"
            aria-label="Код из письма"
            disabled={pending}
            value={step.otp}
            onChange={(e) => handleCodeChange(e.target.value)}
            className="h-11 rounded-xl border border-white/12 bg-white/6 px-4 text-center font-mono text-lg tracking-[0.3em] text-brand-text outline-none focus-visible:border-brand-cyan"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button
            type="button"
            disabled={pending || step.otp.length !== 6}
            onClick={() => void submitCode(step.email, step.otp)}
            className="h-11 w-full rounded-xl bg-brand-gradient text-sm font-semibold text-white"
          >
            Войти
          </Button>
          <p className="text-xs text-brand-muted">
            Письмо не пришло? Проверь спам или отправь ещё раз
          </p>
          <div className="flex items-center gap-2 text-xs">
            <Button
              type="button"
              variant="link"
              disabled={!canResend || pending}
              onClick={() => void requestCode(step.email)}
              className="h-auto p-0 text-brand-cyan disabled:text-brand-dim disabled:no-underline"
            >
              Отправить ещё раз
            </Button>
            {!canResend && (
              <span className="text-brand-dim">через {remaining}с</span>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-brand-dim">
        Входя, ты создаёшь аккаунт GameCrate, если его ещё нет
      </p>
      {providers.pocketId && (
        <Button
          type="button"
          variant="link"
          onClick={() => void signInWithProvider("pocket-id", "/admin")}
          className="h-auto justify-self-start p-0 text-xs text-brand-muted"
        >
          Вход для команды
        </Button>
      )}
    </div>
  );
}
