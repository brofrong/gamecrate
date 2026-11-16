//! Игровой полный экран: нативный полный экран окна + перехват системных сочетаний.
//!
//! Сайт зовёт `enter_game_fullscreen` / `exit_game_fullscreen` (кнопка «На весь экран», удержание
//! Esc). О каждом входе и выходе — в том числе средствами ОС (зелёная кнопка, Ctrl+Cmd+F) —
//! странице приходит DOM-событие `gamecrate:game-fullscreen` с `detail: true|false`
//! ([`event_script`]). Не событие Tauri: право `core:event:*` расширило бы права сайта сверх
//! шести команд моста.
//!
//! Перехват действует, только пока окно в фокусе и правда на весь экран ([`capture_wanted`]):
//! потеря фокуса снимает его, возврат — включает снова.
//! - macOS: `NSApplication.presentationOptions` — без Dock, меню и Cmd+Tab (`macos.rs`).
//! - Windows: пока только полный экран окна; Win/Alt+Tab ловит `navigator.keyboard.lock()` на
//!   странице, если WebView2 его умеет (`windows.rs`).
//! - Linux: только полный экран окна (`linux.rs`).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
use self::windows as platform;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

use crate::status::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, Runtime, WebviewWindow, Window, WindowEvent};

/// Перехват нужен: игровой полный экран включён, окно в фокусе и на весь экран.
pub fn capture_wanted(active: bool, focused: bool, fullscreen: bool) -> bool {
    active && focused && fullscreen
}

/// Окно вышло из полного экрана не по нашей команде (зелёная кнопка, Ctrl+Cmd+F): игровой режим
/// выключить и сказать странице.
pub fn left_by_os(active: bool, fullscreen: bool) -> bool {
    active && !fullscreen
}

/// Скрипт для страницы: DOM-событие о входе/выходе. Значение — литерал, ничего от страницы.
pub fn event_script(on: bool) -> &'static str {
    if on {
        r#"window.dispatchEvent(new CustomEvent("gamecrate:game-fullscreen",{detail:true}))"#
    } else {
        r#"window.dispatchEvent(new CustomEvent("gamecrate:game-fullscreen",{detail:false}))"#
    }
}

fn tell_page<R: Runtime>(app: &tauri::AppHandle<R>, on: bool) {
    if let Some(webview) = app.get_webview_window(crate::MAIN) {
        if let Err(err) = webview.eval(event_script(on)) {
            eprintln!("gamecrate: событие полного экрана: {err}");
        }
    }
}

/// Войти: полный экран окна, перехват (если окно в фокусе), событие странице.
pub fn enter<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.set_fullscreen(true)?;
    window
        .state::<AppState>()
        .game_fullscreen
        .store(true, Ordering::SeqCst);
    // `set_fullscreen` лишь ставит переход в очередь: окно ещё не на весь экран, и macOS тут
    // перехват не включит (`macos::next_options`) — он включится по `Resized` из
    // `windowDidEnterFullScreen`. Здесь — на случай, если окно уже было на весь экран.
    let focused = window.is_focused().unwrap_or(true);
    platform::set_capture(window.app_handle(), capture_wanted(true, focused, true));
    tell_page(window.app_handle(), true);
    Ok(())
}

/// Выйти (если игровой полный экран включён): снять перехват, выйти из полного экрана,
/// событие странице. Повторный вызов — ничего не делает: свой полный экран игрока (зелёная
/// кнопка вне игры) уход со страницы сессии не трогает.
pub fn exit<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let app = window.app_handle();
    if !app
        .state::<AppState>()
        .game_fullscreen
        .swap(false, Ordering::SeqCst)
    {
        return Ok(());
    }
    platform::set_capture(app, false);
    window.set_fullscreen(false)?;
    tell_page(app, false);
    Ok(())
}

/// Страница главного окна сменилась (перезагрузка, уход с сайта) — игровой режим снять: экрана
/// сессии больше нет, а Cmd+Tab и Dock остались бы выключенными.
pub fn on_page_load<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(err) = exit(window) {
        eprintln!("gamecrate: выход из полного экрана: {err}");
    }
}

/// Фокус и размер главного окна: перехват по [`capture_wanted`], выход средствами ОС.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let active = state.game_fullscreen.load(Ordering::SeqCst);
    // вне игры — только снять перехват, если он вдруг остался (macOS может вернуть игровые
    // опции при выходе из полноэкранного пространства уже после команды выхода); без игровых
    // флагов это ничего не меняет, страницу не трогаем
    if !active {
        platform::set_capture(app, false);
        return;
    }
    let focused = match event {
        WindowEvent::Focused(focused) => *focused,
        _ => window.is_focused().unwrap_or(false),
    };
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    if left_by_os(active, fullscreen) {
        // `swap`: выход по команде мог успеть раньше — тогда он уже всё сделал
        if state.game_fullscreen.swap(false, Ordering::SeqCst) {
            platform::set_capture(app, false);
            tell_page(app, false);
        }
        return;
    }
    platform::set_capture(app, capture_wanted(active, focused, fullscreen));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_only_in_focused_game_fullscreen() {
        assert!(capture_wanted(true, true, true));
        // потеря фокуса — перехват снять
        assert!(!capture_wanted(true, false, true));
        // окно уже не на весь экран
        assert!(!capture_wanted(true, true, false));
        // свой полный экран игрока вне игры — без перехвата
        assert!(!capture_wanted(false, true, true));
    }

    #[test]
    fn os_exit_detected_only_in_game_mode() {
        assert!(left_by_os(true, false));
        assert!(!left_by_os(true, true));
        assert!(!left_by_os(false, false));
        assert!(!left_by_os(false, true));
    }

    #[test]
    fn page_event_carries_literal_flag() {
        assert_eq!(
            event_script(true),
            r#"window.dispatchEvent(new CustomEvent("gamecrate:game-fullscreen",{detail:true}))"#
        );
        assert_eq!(
            event_script(false),
            r#"window.dispatchEvent(new CustomEvent("gamecrate:game-fullscreen",{detail:false}))"#
        );
    }
}
