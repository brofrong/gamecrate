// TODO(owner): официальный SVG. Пока временная заглушка: скруглённый жёлтый знак и слово
// «билайн» шрифтом витрины, тёмный текст на жёлтом. Фирменный знак не имитируем.

type BeelineLogoProps = {
  /** Высота в px. */
  height?: number;
  /** Только знак, без слова. */
  iconOnly?: boolean;
  /** Анимации у заглушки нет — свёртка по скроллу игнорируется. */
  progress?: number;
  /** aria-label. */
  title?: string;
};

const ACCENT = "var(--brand-accent, #ffc800)";
const ON_ACCENT = "var(--brand-on-accent, #28303f)";

export function BeelineLogo({
  height = 36,
  iconOnly = false,
  title = "билайн",
}: BeelineLogoProps) {
  // Знак — квадрат 40×40, лок-ап — плашка 120×40 со словом по центру.
  const width = iconOnly ? height : height * 3;
  return (
    <svg
      role="img"
      aria-label={title}
      width={width}
      height={height}
      viewBox={iconOnly ? "0 0 40 40" : "0 0 120 40"}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={iconOnly ? 40 : 120} height={40} rx={10} fill={ACCENT} />
      {iconOnly ? (
        <circle cx={20} cy={20} r={7} fill={ON_ACCENT} />
      ) : (
        <text
          x={60}
          y={27}
          textAnchor="middle"
          fontFamily="var(--font-sans)"
          fontSize={22}
          fontWeight={700}
          fill={ON_ACCENT}
        >
          билайн
        </text>
      )}
    </svg>
  );
}
