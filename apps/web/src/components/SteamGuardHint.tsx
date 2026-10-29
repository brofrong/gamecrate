// Подсказка к входу по QR: что нажимать в приложении Steam после сканирования. Четыре
// мини-экрана в цветах приложения Steam (по снимкам владельца 2026-10-29), нужный вариант
// обведён и отмечен галочкой. Шаги 2–4 — проверка «Необычная попытка входа»: Steam
// показывает её, когда игрок далеко от сервера (вход идёт с IP сервера, не игрока).
import { Check } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Местоположение сервера так, как его пишет Steam (по IP brofrong). Сменится IP или
 * появится второй сервер — поправить здесь.
 */
export const STEAM_SERVER_LOCATION = "Tyarlevo, Sankt-Peterburg, RU";

/** Галочка на выбранном варианте — как отметка на снимке, только заметнее. */
function Tick() {
  return (
    <span className="absolute -top-2 -right-2 grid size-4 place-items-center rounded-full bg-[#3bb54a] text-white">
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

/** Вариант ответа: серая плашка, выбранный — белая рамка, жирный текст и галочка. */
function Option({
  children,
  picked = false,
}: {
  children: React.ReactNode;
  picked?: boolean;
}) {
  return (
    <div
      data-picked={picked || undefined}
      className={cn(
        "relative rounded-[2px] bg-[#3a3e4a] px-2 py-1.5",
        picked
          ? "font-bold text-white outline outline-[1.5px] outline-white"
          : "text-[#9aa0ab]",
      )}
    >
      {children}
      {picked && <Tick />}
    </div>
  );
}

/** Синяя кнопка «Войти в Steam» — её нажимают в шагах 1 и 4. */
function SignInButton() {
  return (
    <div
      data-picked
      className="relative rounded-[2px] bg-[#1a9fff] py-1.5 text-center text-white outline-2 outline-offset-2 outline-white"
    >
      Войти в Steam
      <Tick />
    </div>
  );
}

function Question({ children }: { children: React.ReactNode }) {
  return <p className="my-0.5 text-center font-bold">{children}</p>;
}

/** Мини-экран телефона в цветах приложения Steam. */
function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-36 flex-col gap-1.5 rounded-2xl border-[3px] border-[#111] bg-[#262a33] p-2.5 text-[10px] leading-tight text-white">
      {children}
    </div>
  );
}

function Step({
  n,
  caption,
  children,
}: {
  n: number;
  caption: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
        ШАГ {n}
      </span>
      <Phone>{children}</Phone>
      <p className="text-xs leading-snug">{caption}</p>
    </li>
  );
}

/**
 * `wide` — после сканирования QR уже не нужен, и шаги встают в один ряд на всю ширину
 * (на узком экране — по два).
 */
export function SteamGuardHint({ wide = false }: { wide?: boolean }) {
  return (
    <section className="flex flex-col gap-2.5 text-left">
      <h3 className="text-sm font-semibold">Что нажать в приложении Steam</h3>
      <ol className={cn("grid grid-cols-2 gap-3", wide && "sm:grid-cols-4")}>
        <Step
          n={1}
          caption={
            <>
              Нажмите <b>«Войти в Steam»</b>. Санкт-Петербург — это наш сервер,
              так и должно быть
            </>
          }
        >
          <p className="text-center">
            Вы отсканировали QR-код, чтобы войти в Steam
          </p>
          <Question>Клиент Steam</Question>
          <span className="self-center rounded-full bg-[#e05a5a] px-2 py-0.5 text-center text-[9.5px] font-bold">
            {STEAM_SERVER_LOCATION}
          </span>
          <SignInButton />
          <div className="rounded-[2px] bg-[#3a3e4a] py-1.5 text-center text-[#ddd]">
            Отмена
          </div>
        </Step>
        <Step n={2} caption={<b>«Через клиент Steam»</b>}>
          <div className="rounded-[2px] bg-[#e05a5a] p-1 text-center text-[9px] font-bold">
            Требуется дополнительная проверка безопасности
          </div>
          <Question>Как вы пытаетесь войти?</Question>
          <Option>Через мобильное приложение…</Option>
          <Option picked>Через клиент Steam</Option>
          <Option>Через браузер…</Option>
          <Option>Я не пытаюсь войти в Steam</Option>
        </Step>
        <Step
          n={3}
          caption={
            <>
              <b>Sankt-Peterburg</b> — даже если вы в другом городе: там наш
              сервер
            </>
          }
        >
          <Question>Выберите ближайшее к вам местоположение</Question>
          <Option>Ваш город</Option>
          <Option picked>{STEAM_SERVER_LOCATION}</Option>
        </Step>
        <Step
          n={4}
          caption={
            <>
              <b>«Другое»</b>, затем <b>«Войти в Steam»</b>
            </>
          }
        >
          <Question>Что вы пытаетесь сделать?</Question>
          <Option>Войти на сайт турнира или обмена</Option>
          <Option>…</Option>
          <Option picked>Другое</Option>
          <SignInButton />
        </Step>
      </ol>
      <p className="text-[11.5px] text-muted-foreground">
        Шаги 2–4 Steam показывает, только если вы далеко от Санкт-Петербурга.
      </p>
    </section>
  );
}
