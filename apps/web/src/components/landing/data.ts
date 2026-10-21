// Данные-константы лендинга: платформы, обложки, плюсы, тарифы, ачивки, FAQ.
import {
  CloudUpload,
  Gamepad2,
  LibraryBig,
  type LucideIcon,
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

/** Три заметки под сценой «Технология». */
export const techNotes: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: "Контейнер на игру",
    text: "Игра живёт в изолированном контейнере со своим Steam и своей долей GPU. Вышел — контейнер удалился, следы не остаются.",
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
