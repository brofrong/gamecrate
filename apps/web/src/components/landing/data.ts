// Данные-константы лендинга: платформы, обложки, плюсы, тарифы, ачивки, FAQ.
import {
  CloudUpload,
  Gamepad2,
  Gift,
  Hourglass,
  LibraryBig,
  type LucideIcon,
  MapPin,
  MonitorCheck,
  MonitorSmartphone,
  Zap,
} from "lucide-react";

/** Где играть в первом релизе — чипы над заголовком hero. */
export const platforms = ["Браузер", "Windows · macOS", "Android · iOS"];

/** Обложки стены в hero (популярные игры; CDN Steam отдаёт их без ошибок ORB). */
export const heroAppIds: ReadonlyArray<number> = [
  1091500, 1245620, 1145350, 1086940, 413150, 367520, 1030300, 570, 730, 105600,
  427520, 374320, 620, 292030, 504230, 220, 646570, 294100, 632470, 753640,
  526870, 892970, 548430, 2379780, 271590, 1174180, 814380, 1172470, 1623730,
  553850, 1966720, 2358720, 2246340, 2767030, 3164500, 1771300, 2001120,
  1903340, 3017860, 3241660,
];

export const coverUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
export const headerUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

/** Шесть честных плюсов под кнопкой «Играть». */
export const perks: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  text: string;
}> = [
  {
    icon: MonitorCheck,
    title: "До 4K · 60 FPS",
    text: "Картинка как на топовом ПК",
  },
  { icon: Zap, title: "Старт за секунды", text: "Без скачивания и патчей" },
  {
    icon: CloudUpload,
    title: "Прогресс в Steam Cloud",
    text: "Сейвы живут в твоём аккаунте",
  },
  {
    icon: LibraryBig,
    title: "Вся библиотека",
    text: "Не каталог, а твои игры",
  },
  { icon: Gamepad2, title: "Любой ввод", text: "Геймпад, клава и мышь" },
  {
    icon: MonitorSmartphone,
    title: "С любого экрана",
    text: "Начал на ПК, продолжил с телефона",
  },
];

/** «В любой подписке» у партнёра (билайн): только то, что сервис уже даёт, без железа и FPS. */
export const partnerPerks: ReadonlyArray<{
  icon: LucideIcon;
  title: string;
  text: string;
}> = [
  {
    icon: LibraryBig,
    title: "Вся библиотека Steam",
    text: "Твои игры, а не чужой каталог",
  },
  { icon: Zap, title: "Без скачивания", text: "Старт за секунды, без патчей" },
  {
    icon: CloudUpload,
    title: "Сейвы в Steam Cloud",
    text: "Прогресс остаётся в твоём аккаунте",
  },
  {
    icon: MonitorSmartphone,
    title: "С любого экрана",
    text: "Браузер, ПК и телефон",
  },
  { icon: Gamepad2, title: "Любой ввод", text: "Геймпад, клава и мышь" },
  { icon: Gift, title: "Игры без Steam", text: "Бесплатные сборки, Steam-аккаунт не нужен" },
  {
    icon: Hourglass,
    title: "Сессия ждёт",
    text: "Оборвалась связь — игра подождёт",
  },
  { icon: MapPin, title: "Сервера в России", text: "Короткий пинг" },
];

/** Три заметки под сценой «Технология». */
export const techNotes: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: "Облако на игру",
    text: "Игра живёт в своём изолированном облаке со своим Steam и своей долей GPU. Вышел — облако исчезло, следы не остаются.",
  },
  {
    title: "Видео вместо игры",
    text: "На твою сторону идёт H.264/AV1-поток с аппаратным кодированием, а не сама игра. Поэтому хватает любого устройства.",
  },
  {
    title: "Сервера рядом",
    text: "Дата-центр в России, чтобы пинг был 10–30 мс, а не 100. Задержку видно в оверлее прямо в игре.",
  },
];

/** Три шага «Как это работает». */
export const steps: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: "Привяжи Steam",
    text: "Один раз отсканируй QR в приложении Steam. Пароль нам не нужен.",
  },
  {
    title: "Выбери игру",
    text: "Вся твоя библиотека с отметкой «запустится / проверь».",
  },
  {
    title: "Нажми Играть",
    text: "Облако поднимается, стрим стартует. Дальше — как на своём ПК.",
  },
];

/** Обложки в демо-библиотеке (6×2). */
export const demoAppIds: ReadonlyArray<number> = [
  1245620, 1086940, 1091500, 1030300, 2767030, 553850, 2358720, 413150, 892970,
  2379780, 1903340, 105600,
];

/** Пока true — над тарифами плашка «цены и цифры — предварительные». */
export const PLANS_ARE_PLACEHOLDERS = true;

export type Plan = {
  name: string;
  who: string;
  hours: number;
  priceRub: number;
  perHourRub: number;
  features: ReadonlyArray<{
    text: string;
    included: boolean;
    gpu?: string;
    strong?: boolean;
  }>;
  popular?: boolean;
};

/** Три тарифа по часам игры (цифры — заглушки до решения владельца). */
export const plans: ReadonlyArray<Plan> = [
  {
    name: "Старт",
    who: "Попробовать и поиграть по вечерам",
    hours: 10,
    priceRub: 490,
    perHourRub: 49,
    features: [
      { text: "1080p · 60 FPS", included: true },
      { text: "Общая очередь на сервер", included: true },
      { text: "Стандартное железо", included: true, gpu: "RTX 3060" },
      { text: "Без очереди", included: false },
      { text: "4K и 120 FPS", included: false },
    ],
  },
  {
    name: "Про",
    who: "Для тех, кто играет каждый день",
    hours: 40,
    priceRub: 1490,
    perHourRub: 37,
    popular: true,
    features: [
      { text: "1440p · 60 FPS", included: true },
      {
        text: "Без очереди — сервер всегда есть",
        included: true,
        strong: true,
      },
      { text: "Быстрое железо", included: true, gpu: "RTX 4070" },
      { text: "Сессия до 8 часов", included: true },
      { text: "4K и 120 FPS", included: false },
    ],
  },
  {
    name: "Ультра",
    who: "Максимум, без компромиссов",
    hours: 120,
    priceRub: 3490,
    perHourRub: 29,
    features: [
      { text: "4K · 120 FPS", included: true, strong: true },
      { text: "Без очереди + приоритет", included: true },
      { text: "Топовое железо", included: true, gpu: "RTX 4090" },
      { text: "Сессия без лимита", included: true },
      { text: "Ранний доступ к новым фичам", included: true },
    ],
  },
];

/** Ачивки; `season` — открывается только в сезонный ивент. */
export const achievements: ReadonlyArray<{
  emoji: string;
  title: string;
  text: string;
  season?: string;
}> = [
  {
    emoji: "🚀",
    title: "Первый запуск",
    text: "Запустил первую игру в облаке",
  },
  { emoji: "🏃", title: "Марафонец", text: "5 часов подряд, не выходя" },
  { emoji: "🦉", title: "Ночная смена", text: "Играл после трёх ночи" },
  {
    emoji: "🔥",
    title: "Феникс",
    text: "Вернулся в сессию после обрыва связи",
  },
  { emoji: "📚", title: "Коллекционер", text: "Запустил 25 разных игр" },
  { emoji: "💯", title: "Сотня", text: "100 часов на платформе" },
  {
    emoji: "💘",
    title: "Настоящая любовь",
    text: "14 февраля провёл с нами",
    season: "Сезонная · февраль",
  },
  {
    emoji: "🎃",
    title: "Тыквенный час",
    text: "Хоррор-марафон на Хэллоуин",
    season: "Сезонная · октябрь",
  },
];

/** FAQ в виде чата: вопрос игрока — ответ витрины. */
export const faq: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "А лагать не будет?",
    a: "При нормальном интернете задержка 10–30 мс. Это меньше, чем у телевизора с геймпадом по Bluetooth. Сервера в России, так что пинг короткий.",
  },
  {
    q: "Какие игры пойдут?",
    a: "Почти всё из Steam. Рядом с каждой игрой в библиотеке стоит отметка — запустится ли без проблем. Онлайн-игры с жёстким античитом пока под вопросом, честно пишем.",
  },
  {
    q: "Сейвы пропадут?",
    a: "Нет, они в Steam Cloud, как обычно. Начал с ноутбука — продолжил с телефона.",
  },
  {
    q: "Надо что-то ставить?",
    a: "В браузере — ничего. На телефоне и ПК будет приложение, но это по желанию.",
  },
  {
    q: "А если интернет оборвётся?",
    a: "Игра живёт ещё несколько минут и ждёт тебя. Вернулся — продолжил с того же места. И получил ачивку «Феникс».",
  },
];
