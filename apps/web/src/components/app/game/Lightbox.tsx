// Простой лайтбокс для скриншотов (спека 2026-10-27 §3.5): диалог на весь экран,
// Esc закрывает, ←/→ листают по кругу, кнопки «Назад»/«Вперёд»/«Закрыть». Без
// зависимостей: `role="dialog"`, фокус на кнопке «Закрыть» при открытии.
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";

const iconButtonClassName =
  "flex size-11 items-center justify-center rounded-full bg-black/60 text-[#eef1ff] transition hover:bg-black/85";

export function Lightbox({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: ReadonlyArray<string>;
  index: number;
  onClose: () => void;
  onIndex: (index: number) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const count = items.length;
  const prev = () => onIndex((index - 1 + count) % count);
  const next = () => onIndex((index + 1) % count);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") prev();
      else if (event.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Скриншот ${index + 1} из ${count}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <img
        src={items[index]}
        alt=""
        className="max-h-full max-w-full rounded-lg object-contain"
        onClick={(event) => event.stopPropagation()}
      />
      <button
        ref={closeRef}
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className={`${iconButtonClassName} absolute top-4 right-4`}
      >
        <X className="size-5" />
      </button>
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Назад"
            onClick={(event) => {
              event.stopPropagation();
              prev();
            }}
            className={`${iconButtonClassName} absolute top-1/2 left-4 -translate-y-1/2`}
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            aria-label="Вперёд"
            onClick={(event) => {
              event.stopPropagation();
              next();
            }}
            className={`${iconButtonClassName} absolute top-1/2 right-4 -translate-y-1/2`}
          >
            <ChevronRight className="size-5" />
          </button>
        </>
      )}
    </div>
  );
}
