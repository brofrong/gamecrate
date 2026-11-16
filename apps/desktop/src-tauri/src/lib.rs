mod commands;
mod nav;
mod status;
mod tray;

use nav::Nav;
use status::{close_action, hidden_notice, AppState, CloseAction};
use std::sync::atomic::Ordering;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Метка главного окна (на неё опираются single-instance, а дальше трей и deep link).
pub(crate) const MAIN: &str = "main";

/// Фон окна до загрузки страницы — тёмный фон бренда, без белой вспышки.
const BACKGROUND: Color = Color(5, 6, 15, 255);

/// Суффикс User-Agent: сайт и логи отличают приложение. Сам сайт узнаёт приложение по мосту
/// Tauri, а не по UA.
fn ua_suffix() -> String {
    format!("GameCrateDesktop/{}", env!("CARGO_PKG_VERSION"))
}

/// macOS: стандартный UA WKWebView (Apple его заморозила) + суффикс.
#[cfg(target_os = "macos")]
fn user_agent() -> Option<String> {
    Some(format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) {}",
        ua_suffix()
    ))
}

/// Windows и Linux: Tauri умеет только заменить UA целиком, а стандартный там зависит от
/// версии WebView2/WebKitGTK — дописать суффикс можно только нативным вызовом после создания
/// webview, это сделаем при проверке на этих ОС (задача 3). Пока UA стандартный.
#[cfg(not(target_os = "macos"))]
fn user_agent() -> Option<String> {
    let _ = ua_suffix;
    None
}

/// Чужая ссылка — в системный браузер (почта — в почтовый клиент).
fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("gamecrate: не открыть {url} в браузере: {err}");
        }
    }
}

/// Показать и сфокусировать главное окно (второй запуск, трей, клик по уведомлению, Dock).
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Главное окно. Сначала открывается заглушка из бандла: она проверяет, что сайт отвечает, и
/// сразу уходит на `<сайт>/app`; без сети остаётся на экране с кнопкой «Повторить».
fn build_main(app: &AppHandle) -> tauri::Result<()> {
    let public = nav::public_url();
    let start = nav::start_url(nav::public_base());

    let nav_app = app.clone();
    let nav_public = public.clone();
    let popup_app = app.clone();
    let load_public = public.clone();
    // `tauri dev` сам раздаёт заглушку (frontendDist) с http://127.0.0.1:1430 — в отладочной
    // сборке это тоже «страница из бандла», иначе окно отправило бы её в браузер.
    let dev_server = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };

    let mut builder = WebviewWindowBuilder::new(
        app,
        MAIN,
        WebviewUrl::App(nav::offline_query(&start).into()),
    )
    .title("GameCrate")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 600.0)
    .center()
    .background_color(BACKGROUND)
    // Окно в трее не должно засыпать: heartbeat очереди (`QueueWatcher`) идёт со страницы.
    // Работает на macOS 14+ (WKWebView); на Windows/Linux Tauri этого не умеет — проверка там
    // в задаче 3, при троттлинге heartbeat переедет в Rust.
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .on_navigation(move |url| {
        if dev_server
            .as_ref()
            .is_some_and(|dev| nav::is_internal(url, dev))
        {
            return true;
        }
        match nav::decide(url, &nav_public) {
            Nav::Allow => true,
            Nav::OpenInBrowser => {
                open_external(&nav_app, url);
                false
            }
            Nav::Block => false,
        }
    })
    // target="_blank" и window.open: второго окна нет. Даже свою страницу открываем в браузере —
    // иначе ссылка «Тарифы» из игры заменила бы экран сессии.
    .on_new_window(move |url, _features| {
        if nav::decide(&url, &public) != Nav::Block {
            open_external(&popup_app, &url);
        }
        NewWindowResponse::Deny
    });

    if let Some(ua) = user_agent() {
        builder = builder.user_agent(&ua);
    }

    // Ушли с сайта (заглушка без сети) — статус сбросить: заглушка не умеет `set_status`, а
    // старый «в очереди»/«в игре» прятал бы окно в трей. Перезагрузку сайта не трогаем —
    // страница сама пришлёт статус заново.
    builder = builder.on_page_load(move |webview, payload| {
        #[cfg(debug_assertions)]
        eprintln!("gamecrate: {:?} {}", payload.event(), payload.url());
        if !nav::is_internal(payload.url(), &load_public) {
            reset_status(webview.app_handle());
        }
    });

    builder.build()?;
    Ok(())
}

/// Статус — в `Idle` (и трей, если он был другим).
fn reset_status<R: Runtime>(app: &AppHandle<R>) {
    let idle = status::Status::Idle;
    if app.state::<AppState>().replace_status(idle.clone()) != idle {
        tray::update(app, &idle);
    }
}

/// Контекст сборки (конфиг, ассеты, ACL). Один `generate_context!` на крейт: на macOS он встраивает
/// Info.plist, второй вызов (в тестах) дал бы повторный символ.
pub(crate) fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Крестик главного окна: в очереди и в игре — спрятать в трей (уведомить один раз за запуск),
/// иначе закрыть (последнее окно — приложение выходит).
fn on_close_requested<R: Runtime>(window: &Window<R>, api: &tauri::CloseRequestApi) {
    let state = window.state::<AppState>();
    let status = state.status();
    let shown = state.hidden_notice_shown.load(Ordering::Relaxed);
    if let CloseAction::HideToTray { notify } = close_action(&status, shown) {
        api.prevent_close();
        let _ = window.hide();
        if notify {
            state.hidden_notice_shown.store(true, Ordering::Relaxed);
            let shown = window
                .app_handle()
                .notification()
                .builder()
                .title(hidden_notice(&status))
                .show();
            if let Err(err) = shown {
                eprintln!("gamecrate: уведомление: {err}");
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        // первым: второй запуск не поднимает остальное, а будит уже открытое окно
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(commands::handler())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    on_close_requested(window, api);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // права страниц сайта — до первого окна; адрес — тот, что зашит в сборку
            handle.add_capability(commands::site_capability(nav::public_base()))?;
            // клик по уведомлению («Сервер готов») — показать окно; до первого уведомления,
            // иначе клик по нему не придёт
            let on_click = handle.clone();
            handle
                .notification()
                .on_action(move |_| show_main(&on_click))?;
            tray::create(&handle)?;
            build_main(&handle)?;
            Ok(())
        })
        .build(context())
        .expect("GameCrate не запустился")
        .run(|app, event| {
            // macOS: клик по иконке в Dock, когда окно спрятано в трей
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
