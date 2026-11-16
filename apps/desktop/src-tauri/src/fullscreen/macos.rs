//! macOS: перехват через `NSApplication.presentationOptions` (без разрешения «Универсальный
//! доступ»): Dock и меню скрыты, Cmd+Tab и «Скрыть» выключены, пока окно в игре и в фокусе.
//!
//! AppKit бросает `NSInvalidArgumentException` на недопустимые сочетания флагов
//! (документация `-[NSApplication setPresentationOptions:]`):
//! - `AutoHideDock` и `HideDock` — взаимоисключающие, `AutoHideMenuBar` и `HideMenuBar` — тоже;
//! - `HideMenuBar` — только вместе с `HideDock`;
//! - `AutoHideMenuBar` — только с `HideDock` или `AutoHideDock`;
//! - `DisableProcessSwitching`, `DisableForceQuit`, `DisableSessionTermination`,
//!   `DisableMenuBarTransparency` — только с `HideDock` или `AutoHideDock`;
//! - `AutoHideToolbar` — только с `FullScreen` и `AutoHideMenuBar`.
//!
//! Поэтому опции считаются от текущих ([`game_options`], [`normal_options`]), проверяются
//! [`allowed`], а сам вызов ещё и обёрнут в `objc2::exception::catch` — исключение не роняет
//! приложение. Флаг `FullScreen` (полноэкранное пространство окна) ставит система — его не
//! трогаем.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions as Options};
use std::panic::AssertUnwindSafe;
use tauri::{AppHandle, Runtime};

/// Что включаем на время игры.
const GAME: Options = Options::HideDock
    .union(Options::HideMenuBar)
    .union(Options::DisableProcessSwitching)
    .union(Options::DisableHideApplication);

/// Что система ставит в полноэкранном пространстве и что несовместимо с [`GAME`].
const AUTO_HIDE: Options = Options::AutoHideDock
    .union(Options::AutoHideMenuBar)
    .union(Options::AutoHideToolbar);

/// Опции на время игры: вместо «появляются при наведении» — скрыты совсем, плюс без Cmd+Tab и
/// «Скрыть». Прочие флаги (в т.ч. `FullScreen`) — как были.
pub fn game_options(current: Options) -> Options {
    current.difference(AUTO_HIDE).union(GAME)
}

/// Обычные опции: снять игровые; в полноэкранном пространстве вернуть системные
/// «Dock и меню при наведении».
pub fn normal_options(current: Options) -> Options {
    let base = current.difference(GAME);
    if base.contains(Options::FullScreen) {
        base | Options::AutoHideDock | Options::AutoHideMenuBar
    } else {
        base
    }
}

/// Опции после включения (`on`) или снятия перехвата. Включаем только в полноэкранном
/// пространстве (`FullScreen` уже стоит): AppKit при входе окна в полный экран запоминает
/// текущие опции и возвращает их при выходе — игровые, поставленные до входа, остались бы
/// после игры (без Dock, меню и Cmd+Tab). До входа ждём `Resized`/`Focused` в конце перехода.
pub fn next_options(current: Options, on: bool) -> Options {
    if on && current.contains(Options::FullScreen) {
        game_options(current)
    } else {
        normal_options(current)
    }
}

/// Сочетание, которое AppKit примет (правила — в шапке модуля).
pub fn allowed(options: Options) -> bool {
    let has = |flags: Options| options.contains(flags);
    let any = |flags: Options| options.intersects(flags);
    let dock = any(Options::HideDock | Options::AutoHideDock);
    let needs_dock = Options::DisableProcessSwitching
        | Options::DisableForceQuit
        | Options::DisableSessionTermination
        | Options::DisableMenuBarTransparency;
    !has(Options::HideDock | Options::AutoHideDock)
        && !has(Options::HideMenuBar | Options::AutoHideMenuBar)
        && (!has(Options::HideMenuBar) || has(Options::HideDock))
        && (!has(Options::AutoHideMenuBar) || dock)
        && (!any(needs_dock) || dock)
        && (!has(Options::AutoHideToolbar) || has(Options::FullScreen | Options::AutoHideMenuBar))
}

/// Включить или снять перехват. Вызов AppKit — на главном потоке.
pub fn set_capture<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Err(err) = app.run_on_main_thread(move || apply(on)) {
        eprintln!("gamecrate: перехват клавиш: {err}");
    }
}

fn apply(on: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let current = app.presentationOptions();
    let next = next_options(current, on);
    if next == current {
        return;
    }
    if !allowed(next) {
        eprintln!("gamecrate: недопустимые presentationOptions {next:?} (сейчас {current:?})");
        return;
    }
    if let Err(err) = objc2::exception::catch(AssertUnwindSafe(|| app.setPresentationOptions(next)))
    {
        eprintln!("gamecrate: presentationOptions {next:?}: {err:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Что система ставит окну в полноэкранном пространстве.
    const SYSTEM_FULLSCREEN: Options = Options::FullScreen
        .union(Options::AutoHideDock)
        .union(Options::AutoHideMenuBar)
        .union(Options::AutoHideToolbar);

    #[test]
    fn game_options_in_fullscreen_space() {
        let game = game_options(SYSTEM_FULLSCREEN);
        assert_eq!(game, Options::FullScreen | GAME);
        assert!(allowed(game), "{game:?}");
    }

    #[test]
    fn game_options_from_default() {
        let game = game_options(Options::Default);
        assert_eq!(game, GAME);
        assert!(allowed(game));
        // повторное включение ничего не меняет
        assert_eq!(game_options(game), game);
    }

    #[test]
    fn normal_options_restore_system_fullscreen() {
        let normal = normal_options(game_options(SYSTEM_FULLSCREEN));
        assert_eq!(
            normal,
            Options::FullScreen | Options::AutoHideDock | Options::AutoHideMenuBar
        );
        assert!(allowed(normal));
        // вне полноэкранного пространства — обычные опции
        assert_eq!(normal_options(GAME), Options::Default);
        // уже обычные — без изменений
        assert_eq!(normal_options(SYSTEM_FULLSCREEN), SYSTEM_FULLSCREEN);
        assert_eq!(normal_options(Options::Default), Options::Default);
    }

    #[test]
    fn capture_waits_for_fullscreen_space() {
        // окно ещё не вошло в полный экран — игровые опции не ставим
        assert_eq!(next_options(Options::Default, true), Options::Default);
        // AppKit вернул игровые опции после выхода — снимаем их
        assert_eq!(next_options(GAME, true), Options::Default);
        assert_eq!(
            next_options(SYSTEM_FULLSCREEN, true),
            Options::FullScreen | GAME
        );
        assert_eq!(
            next_options(Options::FullScreen | GAME, false),
            Options::FullScreen | Options::AutoHideDock | Options::AutoHideMenuBar
        );
    }

    #[test]
    fn allowed_follows_appkit_rules() {
        assert!(allowed(Options::Default));
        assert!(allowed(SYSTEM_FULLSCREEN));
        assert!(!allowed(Options::HideDock | Options::AutoHideDock));
        assert!(!allowed(
            Options::HideDock | Options::HideMenuBar | Options::AutoHideMenuBar
        ));
        assert!(!allowed(Options::HideMenuBar));
        assert!(!allowed(Options::HideMenuBar | Options::AutoHideDock));
        assert!(!allowed(Options::AutoHideMenuBar));
        assert!(allowed(Options::AutoHideDock | Options::AutoHideMenuBar));
        assert!(!allowed(Options::DisableProcessSwitching));
        assert!(allowed(
            Options::AutoHideDock | Options::DisableProcessSwitching
        ));
        assert!(!allowed(Options::DisableForceQuit));
        assert!(!allowed(Options::DisableSessionTermination));
        assert!(!allowed(Options::DisableMenuBarTransparency));
        // панель инструментов — только в полноэкранном пространстве с меню «при наведении»
        assert!(!allowed(
            Options::FullScreen
                | Options::HideDock
                | Options::HideMenuBar
                | Options::AutoHideToolbar
        ));
        assert!(!allowed(
            Options::AutoHideDock | Options::AutoHideMenuBar | Options::AutoHideToolbar
        ));
    }
}
