# Спайк: стрим Steam-игр в браузер (черновик, будет выброшен)

Контейнер `cg-spike` на `brofrong` (~/cg-spike), образ `ghcr.io/selkies-project/selkies-egl-desktop:26.04`.

## Как зайти

```sh
ssh -f -N -L 8080:localhost:8080 brofrong   # туннель (порт 8080 наружу не проброшен)
open http://localhost:8080                   # логин ubuntu, пароль в spike/.env
```

Видео идёт не через туннель, а напрямую по UDP на 37.153.14.138:59000.

## Что выяснили

| Что | Было (прошлые тесты) | Сейчас |
|---|---|---|
| Транспорт | `websockets` (TCP) — по умолчанию в Selkies 2.0 и linuxserver/steam | `webrtc` по UDP |
| Сеть | — | один UDP-порт 59000 (UDP mux + ICE-lite + публичный IP), из интернета доходит напрямую, TURN не нужен |
| Кодирование | — | NVENC H.264 на GTX 1650 Super |
| Захват | — | Wayland zero-copy (GBM), без копии кадра через CPU |

Замер с Mac через интернет (рабочий стол, без игры): 60 fps, кодирование ~5 мс, захват→кодирование ~1,4 мс, потери 0, путь `host udp`.

Что для этого понадобилось на хосте:
- `/etc/modprobe.d/nvidia-drm-modeset.conf` с `options nvidia-drm modeset=1` + `update-initramfs -u` + перезагрузка;
- проброс `libnvidia-allocator` (GBM-бэкенд NVIDIA) в контейнер — в Debian он в `nvidia/current/`, NVIDIA Container Toolkit его не находит.

## Проверено 2026-10-16

| Что | Результат |
|---|---|
| Steam в контейнере | нужны 32-битные libs NVIDIA той же версии, что драйвер хоста (см. Dockerfile) |
| Геймпад | DualSense → виртуальный Xbox 360 через selkies_input_interposer, Steam видит |
| Вход в Steam после пересоздания контейнера | автологин (home в volume), `LogOnResponse 'OK'` за ~1 с |
| Запуск сразу в игру | `steam -silent -applaunch 1794680` из окружения сессии (нужен LD_PRELOAD интерпозера) → игра через 37 с |
| Облачные сохранения | после выхода `cloud_log.txt`: `Upload complete, result OK` (~5 с) — маркер для агента |
| Потери пакетов у клиента | без ключевых кадров картинка замерзает → `SELKIES_KEYFRAME_INTERVAL=2` |
| Стоимость Vampire Survivors (меню) | ~17 % GPU, ~45 МБ VRAM у процесса (~270 МБ вся сессия) |

Нюанс: Vampire Survivors пишет `LastRunBackup.sav` в папку игры — gamestore read-only нужен overlayfs.

## Перезапуск

```sh
ssh brofrong 'cd ~/cg-spike && docker compose up -d --force-recreate'
# SPIKE_AUTH=false — без пароля, SPIKE_WAYLAND=false — старый X11-захват для сравнения
```
