//! Иконка в трее: «Открыть GameCrate», строка статуса (неактивная), «Выйти».

use crate::status::{quit_confirmation, tray_label, AppState, Status};
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const TRAY: &str = "main";
const OPEN: &str = "open";
const STATUS: &str = "status";
const QUIT: &str = "quit";

/// Меню трея. Строку статуса нельзя спрятать у готового меню — меню пересобирается целиком.
fn menu<R: Runtime>(app: &AppHandle<R>, status: &Status) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        OPEN,
        "Открыть GameCrate",
        true,
        None::<&str>,
    )?)?;
    if let Some(label) = tray_label(status) {
        menu.append(&MenuItem::with_id(app, STATUS, label, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, QUIT, "Выйти", true, None::<&str>)?)?;
    Ok(menu)
}

fn tooltip(status: &Status) -> String {
    match tray_label(status) {
        Some(label) => format!("GameCrate — {label}"),
        None => "GameCrate".into(),
    }
}

/// Иконка в трее на всё время работы приложения. Левый клик — окно (на Linux клика нет,
/// там только меню, в нём есть «Открыть GameCrate»), правый — меню.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip(tooltip(&Status::Idle))
        .menu(&menu(app, &Status::Idle)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => crate::show_main(app),
            QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Новый статус — новое меню и подсказка.
pub fn update<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    let Some(tray) = app.tray_by_id(TRAY) else {
        return;
    };
    match menu(app, status) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => eprintln!("gamecrate: меню трея: {err}"),
    }
    let _ = tray.set_tooltip(Some(tooltip(status)));
}

/// «Выйти»: в очереди и в игре — сначала спросить. Сессию приложение не завершает.
fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let status = app.state::<AppState>().status();
    match quit_confirmation(&status) {
        Some(text) => confirm_quit(app, text),
        None => app.exit(0),
    }
}

/// Диалог «Выйти из GameCrate?» (трей и Cmd+Q). Второй, пока открыт первый, не открываем.
/// «Выйти» — `exit(0)` без повторного вопроса.
pub(crate) fn confirm_quit<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let state = app.state::<AppState>();
    if state.quit_dialog_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(text)
        .title("Выйти из GameCrate?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Выйти".into(),
            "Остаться".into(),
        ))
        .show(move |quit| {
            handle
                .state::<AppState>()
                .quit_dialog_open
                .store(false, Ordering::SeqCst);
            if quit {
                handle.exit(0);
            }
        });
}
