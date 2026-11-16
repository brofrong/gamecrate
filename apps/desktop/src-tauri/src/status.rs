//! Состояние игрока для трея и крестика окна. Его присылает сайт командой `set_status`.

use serde::Deserialize;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

/// Что сейчас у игрока. JSON сайта: `{"kind":"queued","position":3,"total":5,"etaMinutes":4}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Status {
    #[default]
    Idle,
    Queued {
        position: u32,
        total: u32,
        eta_minutes: Option<u32>,
    },
    Starting,
    Playing,
}

/// Что делать с крестиком окна.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Quit,
    HideToTray { notify: bool },
}

/// Общее состояние приложения.
#[derive(Debug, Default)]
pub struct AppState {
    pub status: Mutex<Status>,
    /// Уведомление «GameCrate в трее…» уже показывали в этом запуске.
    pub hidden_notice_shown: AtomicBool,
    /// Окно в игровом полном экране (`enter_game_fullscreen`, `crate::fullscreen`).
    pub game_fullscreen: AtomicBool,
    /// Открыт диалог «Выйти из GameCrate?» — второй не открываем.
    pub quit_dialog_open: AtomicBool,
}

impl AppState {
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Записать новый статус, вернуть прежний.
    pub fn replace_status(&self, status: Status) -> Status {
        let mut current = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::replace(&mut current, status)
    }
}

/// Строка статуса в меню трея; `None` — строки нет.
pub fn tray_label(status: &Status) -> Option<String> {
    match status {
        Status::Idle => None,
        // место ещё не посчитано (сервер присылает его не сразу)
        Status::Queued { position: 0, .. } => Some("Вы в очереди".into()),
        Status::Queued {
            position,
            eta_minutes: Some(eta),
            ..
        } => Some(format!("Вы {position}-й в очереди · ~{eta} мин")),
        Status::Queued { position, .. } => Some(format!("Вы {position}-й в очереди")),
        Status::Starting => Some("Сервер готовится".into()),
        Status::Playing => Some("Идёт игра".into()),
    }
}

/// Крестик: без сессии — выход; в очереди и в игре — в трей (уведомление один раз за запуск).
pub fn close_action(status: &Status, hidden_notice_shown: bool) -> CloseAction {
    match status {
        Status::Idle => CloseAction::Quit,
        _ => CloseAction::HideToTray {
            notify: !hidden_notice_shown,
        },
    }
}

/// Текст уведомления, когда крестик спрятал окно в трей.
pub fn hidden_notice(status: &Status) -> &'static str {
    match status {
        Status::Queued { .. } => "GameCrate в трее — вы остаётесь в очереди",
        _ => "GameCrate в трее — игра продолжается",
    }
}

/// Пояснение к подтверждению «Выйти» из трея; `None` — выходим без вопроса. Сессию
/// приложение не завершает: очередь без heartbeat отпустит место, игра — по таймауту простоя.
pub fn quit_confirmation(status: &Status) -> Option<&'static str> {
    match status {
        Status::Idle => None,
        Status::Queued { .. } => Some("Вы выйдете из очереди."),
        Status::Starting | Status::Playing => {
            Some("Игра продолжится, пока не истечёт время ожидания.")
        }
    }
}

/// Что сделать с Cmd+Q / «Выйти» в меню приложения (оно своё только на macOS, `app_menu.rs`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuQuit {
    /// В игровом полном экране сочетание не срабатывает вовсе.
    Ignore,
    /// Выйти сразу.
    Quit,
    /// Спросить, как «Выйти» в трее (текст — [`quit_confirmation`]).
    Confirm(&'static str),
}

/// Cmd+Q / «Выйти» в меню приложения: в игре на весь экран — ничего, иначе как «Выйти» в трее.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu_quit(status: &Status, game_fullscreen: bool) -> MenuQuit {
    if game_fullscreen {
        return MenuQuit::Ignore;
    }
    match quit_confirmation(status) {
        Some(text) => MenuQuit::Confirm(text),
        None => MenuQuit::Quit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued(position: u32, total: u32, eta_minutes: Option<u32>) -> Status {
        Status::Queued {
            position,
            total,
            eta_minutes,
        }
    }

    #[test]
    fn tray_label_for_queue() {
        assert_eq!(
            tray_label(&queued(3, 5, Some(4))).as_deref(),
            Some("Вы 3-й в очереди · ~4 мин")
        );
        assert_eq!(
            tray_label(&queued(3, 5, None)).as_deref(),
            Some("Вы 3-й в очереди")
        );
        // сервер ещё не посчитал место
        assert_eq!(
            tray_label(&queued(0, 0, None)).as_deref(),
            Some("Вы в очереди")
        );
    }

    #[test]
    fn tray_label_for_other_states() {
        assert_eq!(
            tray_label(&Status::Starting).as_deref(),
            Some("Сервер готовится")
        );
        assert_eq!(tray_label(&Status::Playing).as_deref(), Some("Идёт игра"));
        assert_eq!(tray_label(&Status::Idle), None);
    }

    #[test]
    fn close_quits_when_idle() {
        assert_eq!(close_action(&Status::Idle, false), CloseAction::Quit);
        assert_eq!(close_action(&Status::Idle, true), CloseAction::Quit);
    }

    #[test]
    fn close_hides_to_tray_in_queue_and_game() {
        assert_eq!(
            close_action(&queued(3, 5, Some(4)), false),
            CloseAction::HideToTray { notify: true }
        );
        assert_eq!(
            close_action(&Status::Playing, true),
            CloseAction::HideToTray { notify: false }
        );
        assert_eq!(
            close_action(&Status::Starting, false),
            CloseAction::HideToTray { notify: true }
        );
    }

    #[test]
    fn status_from_site_json() {
        let status: Status =
            serde_json::from_str(r#"{"kind":"queued","position":3,"total":5,"etaMinutes":4}"#)
                .unwrap();
        assert_eq!(status, queued(3, 5, Some(4)));
        let status: Status =
            serde_json::from_str(r#"{"kind":"queued","position":1,"total":1,"etaMinutes":null}"#)
                .unwrap();
        assert_eq!(status, queued(1, 1, None));
        assert_eq!(
            serde_json::from_str::<Status>(r#"{"kind":"playing"}"#).unwrap(),
            Status::Playing
        );
        assert_eq!(
            serde_json::from_str::<Status>(r#"{"kind":"idle"}"#).unwrap(),
            Status::Idle
        );
        assert!(serde_json::from_str::<Status>(r#"{"kind":"admin"}"#).is_err());
        assert!(serde_json::from_str::<Status>(
            r#"{"kind":"queued","position":-1,"total":1,"etaMinutes":null}"#
        )
        .is_err());
    }

    #[test]
    fn hidden_notice_text() {
        assert_eq!(
            hidden_notice(&queued(1, 2, None)),
            "GameCrate в трее — вы остаётесь в очереди"
        );
        assert_eq!(
            hidden_notice(&Status::Playing),
            "GameCrate в трее — игра продолжается"
        );
        assert_eq!(
            hidden_notice(&Status::Starting),
            "GameCrate в трее — игра продолжается"
        );
    }

    #[test]
    fn quit_needs_confirmation_only_with_session() {
        assert_eq!(quit_confirmation(&Status::Idle), None);
        assert_eq!(
            quit_confirmation(&queued(2, 4, Some(1))),
            Some("Вы выйдете из очереди.")
        );
        assert_eq!(
            quit_confirmation(&Status::Playing),
            Some("Игра продолжится, пока не истечёт время ожидания.")
        );
        assert_eq!(
            quit_confirmation(&Status::Starting),
            Some("Игра продолжится, пока не истечёт время ожидания.")
        );
    }

    #[test]
    fn menu_quit_confirms_like_tray_and_is_off_in_game_fullscreen() {
        assert_eq!(menu_quit(&Status::Idle, false), MenuQuit::Quit);
        assert_eq!(
            menu_quit(&queued(2, 4, None), false),
            MenuQuit::Confirm("Вы выйдете из очереди.")
        );
        assert_eq!(
            menu_quit(&Status::Starting, false),
            MenuQuit::Confirm("Игра продолжится, пока не истечёт время ожидания.")
        );
        assert_eq!(
            menu_quit(&Status::Playing, false),
            MenuQuit::Confirm("Игра продолжится, пока не истечёт время ожидания.")
        );
        // в игровом полном экране Cmd+Q не срабатывает при любом статусе
        for status in [Status::Idle, Status::Playing, queued(1, 1, Some(1))] {
            assert_eq!(menu_quit(&status, true), MenuQuit::Ignore, "{status:?}");
        }
    }
}
