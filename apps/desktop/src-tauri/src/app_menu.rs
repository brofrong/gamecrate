//! Меню приложения macOS. Как стандартное меню Tauri, но «Выйти» (Cmd+Q) и «Закрыть окно»
//! (Cmd+W) — свои пункты: стандартный `terminate:` закрыл бы приложение сразу, минуя
//! подтверждение в очереди и в игре, а в игровом полном экране оба сочетания не должны
//! срабатывать вовсе ([`crate::status::menu_quit`]).

use crate::status::{menu_quit, AppState, MenuQuit};
use std::sync::atomic::Ordering;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

const QUIT: &str = "app-quit";
const CLOSE: &str = "app-close";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some("GameCrate".into()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "GameCrate",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("О GameCrate"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("Службы"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Скрыть GameCrate"))?,
            &PredefinedMenuItem::hide_others(app, Some("Скрыть остальные"))?,
            &PredefinedMenuItem::show_all(app, Some("Показать все"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Выйти из GameCrate", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    // Правка нужна и в webview: без этих пунктов Cmd+C/Cmd+V в полях сайта не работают.
    let edit = Submenu::with_items(
        app,
        "Правка",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Отменить"))?,
            &PredefinedMenuItem::redo(app, Some("Повторить"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Вырезать"))?,
            &PredefinedMenuItem::copy(app, Some("Копировать"))?,
            &PredefinedMenuItem::paste(app, Some("Вставить"))?,
            &PredefinedMenuItem::select_all(app, Some("Выбрать всё"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "Вид",
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some("Полноэкранный режим"),
        )?],
    )?;
    let window = Submenu::with_items(
        app,
        "Окно",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Свернуть"))?,
            &PredefinedMenuItem::maximize(app, Some("Изменить масштаб"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, CLOSE, "Закрыть окно", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// Пункты меню приложения: «Выйти» — как в трее (с подтверждением в очереди и в игре),
/// «Закрыть окно» — как крестик. В игровом полном экране — ничего.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let state = app.state::<AppState>();
    let game_fullscreen = state.game_fullscreen.load(Ordering::SeqCst);
    match event.id().as_ref() {
        QUIT => match menu_quit(&state.status(), game_fullscreen) {
            MenuQuit::Ignore => {}
            MenuQuit::Quit => app.exit(0),
            MenuQuit::Confirm(text) => crate::tray::confirm_quit(app, text),
        },
        CLOSE if !game_fullscreen => {
            if let Some(window) = app.get_webview_window(crate::MAIN) {
                // как крестик: в очереди и в игре окно уйдёт в трей (`on_close_requested`)
                let _ = window.close();
            }
        }
        _ => {}
    }
}
