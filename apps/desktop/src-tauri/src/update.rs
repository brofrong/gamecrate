//! Автообновление (tauri-plugin-updater): через [`FIRST_CHECK`] после запуска и раз в
//! [`CHECK_EVERY`] спросить `<сайт>/download/desktop/latest.json`; новая версия — скачать тихо и,
//! когда пользователь не в очереди и не в игре ([`prompt_allowed`]), предложить перезапуск.
//! «Позже» — не спрашивать до следующего запуска. Ошибки сети и подписи — только в лог: человек
//! ничего с ними не сделает, а следующая проверка через 6 ч.
//!
//! Адрес берётся из `GAMECRATE_URL` сборки ([`crate::nav::public_base`]), в tauri.conf.json —
//! только публичный ключ. Страницам сайта команды плагина не выданы (`commands::site_capability`),
//! всё делает Rust.

use crate::status::{AppState, Status};
use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Первая проверка — когда окно уже загрузилось и не мешает старту.
pub const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Дальше — раз в 6 ч (приложение неделями живёт в трее).
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Спрашивать про перезапуск можно только без очереди и игры: перезапуск выкинул бы из них.
pub fn prompt_allowed(status: &Status) -> bool {
    matches!(status, Status::Idle)
}

/// `latest.json` на сайте сборки.
pub fn endpoint(base: &str) -> Url {
    Url::parse(&format!(
        "{}/download/desktop/latest.json",
        crate::nav::trim_base(base)
    ))
    .expect("GAMECRATE_URL должен быть адресом вида https://host")
}

/// Умеет ли сборка обновляться сама. Linux: только AppImage (`APPIMAGE` задаёт его загрузчик);
/// `.deb` обновляется пакетом, а плагин нашёл бы в `latest.json` AppImage и упал на установке.
pub fn supported(os: &str, appimage: Option<&OsStr>) -> bool {
    os != "linux" || appimage.is_some_and(|path| !path.is_empty())
}

/// Скачанное обновление и ответ пользователя. Без tauri — чтобы проверять логику тестами.
pub struct Pending<T> {
    ready: Mutex<Option<T>>,
    /// диалог показан (ответа ещё нет) или уже ответили «Позже»
    asked: AtomicBool,
}

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Self {
            ready: Mutex::new(None),
            asked: AtomicBool::new(false),
        }
    }
}

impl<T> Pending<T> {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<T>> {
        self.ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Пора ли спрашивать сервер: ничего не скачано, диалога нет, «Позже» не нажимали.
    pub fn wants_check(&self) -> bool {
        !self.asked.load(Ordering::SeqCst) && self.slot().is_none()
    }

    /// Обновление скачано — ждёт подходящего момента.
    pub fn ready(&self, update: T) {
        if !self.asked.load(Ordering::SeqCst) {
            *self.slot() = Some(update);
        }
    }

    /// Обновление для диалога, если спросить можно сейчас; второй раз не отдаёт.
    pub fn take_if_allowed(&self, status: &Status) -> Option<T> {
        if !prompt_allowed(status) {
            return None;
        }
        let mut slot = self.slot();
        if slot.is_none() || self.asked.swap(true, Ordering::SeqCst) {
            return None;
        }
        slot.take()
    }

    /// Нажали «Перезапустить»: если статус всё ещё позволяет — отдать обновление на установку,
    /// иначе (пока диалог висел, встали в очередь или запустили игру) вернуть его в слот и снять
    /// «спрошено» — на следующем `Idle` диалог появится снова.
    pub fn confirm_restart(&self, status: &Status, update: T) -> Option<T> {
        if prompt_allowed(status) {
            return Some(update);
        }
        let mut slot = self.slot();
        *slot = Some(update);
        self.asked.store(false, Ordering::SeqCst);
        None
    }

    /// «Позже» (или установка не удалась): до следующего запуска не спрашивать и не проверять.
    pub fn decline(&self) {
        self.asked.store(true, Ordering::SeqCst);
        self.slot().take();
    }
}

/// Скачанный установщик.
pub struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

/// Состояние обновления в приложении (`app.manage`).
pub type UpdateState = Pending<Downloaded>;

/// Запустить проверки в фоне (из `setup`). Отладочные сборки не обновляются: они не из
/// установщика, и подменять было бы нечего.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions)
        || !supported(
            std::env::consts::OS,
            std::env::var_os("APPIMAGE").as_deref(),
        )
    {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("gamecrate-update".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                tick(&app);
                std::thread::sleep(CHECK_EVERY);
            }
        });
    if let Err(err) = spawned {
        eprintln!("gamecrate: обновления не проверяются: {err}");
    }
}

/// Одна проверка: если ещё не скачано — спросить сервер и скачать; затем — предложить, если можно.
fn tick<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<UpdateState>() else {
        return;
    };
    if state.wants_check() {
        match tauri::async_runtime::block_on(fetch(app)) {
            Ok(Some(downloaded)) => state.ready(downloaded),
            Ok(None) => {}
            Err(err) => eprintln!("gamecrate: проверка обновления: {err}"),
        }
    }
    let status = app.state::<AppState>().status();
    on_status(app, &status);
}

/// Есть новая версия — скачать. Подпись (minisign, ключ из tauri.conf.json) плагин проверяет в
/// `download`: не сошлась — ошибка здесь, до диалога и установки дело не доходит.
async fn fetch<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_updater::Result<Option<Downloaded>> {
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint(crate::nav::public_base())])?
        .build()?;
    let Some(update) = updater.check().await? else {
        return Ok(None);
    };
    let bytes = update.download(|_, _| {}, || {}).await?;
    Ok(Some(Downloaded { update, bytes }))
}

/// Статус сменился (`set_status`, уход с сайта) или проверка закончилась: скачанное обновление
/// предложить, если теперь можно. Ждём смены статуса, а не опрашиваем.
pub fn on_status<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    let Some(state) = app.try_state::<UpdateState>() else {
        return;
    };
    // открыт вопрос «Выйти?» — не перекрывать его; спросим на следующей смене статуса
    if app
        .state::<AppState>()
        .quit_dialog_open
        .load(Ordering::SeqCst)
    {
        return;
    }
    let Some(downloaded) = state.take_if_allowed(status) else {
        return;
    };
    let answer_app = app.clone();
    app.dialog()
        .message(format!(
            "Доступна версия {}. Перезапустить и обновить?",
            downloaded.update.version
        ))
        .title("Обновление GameCrate")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Перезапустить".into(),
            "Позже".into(),
        ))
        .show(move |restart| {
            let state = answer_app.state::<UpdateState>();
            if !restart {
                state.decline();
                return;
            }
            // диалог мог висеть долго: перезапуск из очереди или игры выкинул бы из них
            let status = answer_app.state::<AppState>().status();
            let Some(downloaded) = state.confirm_restart(&status, downloaded) else {
                return;
            };
            // Windows: установщик запускается, а приложение выходит само (плагин), NSIS
            // открывает новую версию; macOS/AppImage: файлы заменены — перезапуск наш
            match downloaded.update.install(&downloaded.bytes) {
                Ok(()) => answer_app.restart(),
                Err(err) => {
                    eprintln!("gamecrate: установка обновления: {err}");
                    state.decline();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::Status;
    use std::ffi::OsStr;
    use std::time::Duration;

    #[test]
    fn asks_only_when_idle() {
        assert!(prompt_allowed(&Status::Idle));
        assert!(!prompt_allowed(&Status::Queued {
            position: 1,
            total: 3,
            eta_minutes: Some(2),
        }));
        assert!(!prompt_allowed(&Status::Starting));
        assert!(!prompt_allowed(&Status::Playing));
    }

    #[test]
    fn checks_half_a_minute_after_start_then_every_six_hours() {
        assert_eq!(FIRST_CHECK, Duration::from_secs(30));
        assert_eq!(CHECK_EVERY, Duration::from_secs(6 * 60 * 60));
    }

    #[test]
    fn endpoint_follows_site_address() {
        assert_eq!(
            endpoint("https://game.brofrong.ru/").as_str(),
            "https://game.brofrong.ru/download/desktop/latest.json"
        );
        assert_eq!(
            endpoint("http://localhost:3000").as_str(),
            "http://localhost:3000/download/desktop/latest.json"
        );
    }

    #[test]
    fn linux_updates_only_appimage() {
        assert!(supported("macos", None));
        assert!(supported("windows", None));
        assert!(supported(
            "linux",
            Some(OsStr::new("/home/u/GameCrate.AppImage"))
        ));
        assert!(!supported("linux", None), "deb обновляется пакетом");
        assert!(!supported("linux", Some(OsStr::new(""))));
    }

    #[test]
    fn found_update_waits_for_idle() {
        let pending = Pending::default();
        assert!(pending.wants_check());
        pending.ready("0.2.0".to_string());
        assert!(!pending.wants_check(), "уже скачано — повторно не качать");
        assert_eq!(pending.take_if_allowed(&Status::Playing), None);
        assert_eq!(pending.take_if_allowed(&Status::Starting), None);
        assert_eq!(
            pending.take_if_allowed(&Status::Idle),
            Some("0.2.0".to_string())
        );
        // диалог открыт — второй не показывать
        assert_eq!(pending.take_if_allowed(&Status::Idle), None);
        assert!(!pending.wants_check());
    }

    #[test]
    fn later_means_not_until_next_launch() {
        let pending = Pending::default();
        pending.ready("0.2.0".to_string());
        assert!(pending.take_if_allowed(&Status::Idle).is_some());
        pending.decline();
        assert!(!pending.wants_check(), "до следующего запуска не проверять");
        pending.ready("0.3.0".to_string());
        assert_eq!(pending.take_if_allowed(&Status::Idle), None);
    }

    #[test]
    fn restart_goes_ahead_while_still_idle() {
        let pending = Pending::default();
        pending.ready("0.2.0".to_string());
        let update = pending.take_if_allowed(&Status::Idle).unwrap();
        assert_eq!(
            pending.confirm_restart(&Status::Idle, update),
            Some("0.2.0".to_string())
        );
        assert!(!pending.wants_check(), "ставим — больше не проверять");
    }

    #[test]
    fn restart_waits_again_if_status_left_idle_during_dialog() {
        let pending = Pending::default();
        pending.ready("0.2.0".to_string());
        let update = pending.take_if_allowed(&Status::Idle).unwrap();
        // пока диалог висел, человек встал в очередь — перезапуск выкинул бы его
        let queued = Status::Queued {
            position: 1,
            total: 2,
            eta_minutes: None,
        };
        assert_eq!(pending.confirm_restart(&queued, update), None);
        assert!(
            !pending.wants_check(),
            "скачанное снова ждёт, качать заново не нужно"
        );
        assert_eq!(pending.take_if_allowed(&Status::Playing), None);
        assert_eq!(
            pending.take_if_allowed(&Status::Idle),
            Some("0.2.0".to_string()),
            "на следующем Idle спросить снова"
        );
    }

    #[test]
    fn nothing_to_ask_without_update() {
        let pending: Pending<String> = Pending::default();
        assert_eq!(pending.take_if_allowed(&Status::Idle), None);
        assert!(pending.wants_check());
    }
}
