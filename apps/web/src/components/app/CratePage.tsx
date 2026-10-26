// «Из ящика» (`/app/crate`, Task 12) — задел под игры без Steam (спека §4.2):
// пока только вступление и три плитки-заглушки, без данных и без действий.
export function CratePage() {
  return (
    <>
      <h1 className="text-2xl font-bold text-[#eef1ff]">Из ящика</h1>
      <p className="text-sm text-[#8a90a8]">
        Игры, в которые можно играть без Steam. Скоро
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={`crate-placeholder-${i}`}
            className="flex aspect-[460/215] items-center justify-center rounded-[14px] bg-[#1a1d26]"
          >
            <span
              aria-hidden
              className="font-mono text-xs font-bold tracking-wide text-[#8a90a8]"
            >
              GC
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
