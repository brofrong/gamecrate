mod nav;

use nav::Nav;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Метка главного окна (на неё опираются single-instance, а дальше трей и deep link).
const MAIN: &str = "main";

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

/// Показать и сфокусировать главное окно (второй запуск приложения).
fn show_main(app: &AppHandle) {
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
    let start = nav::start_url(nav::PUBLIC_URL);

    let nav_app = app.clone();
    let nav_public = public.clone();
    let popup_app = app.clone();
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

    #[cfg(debug_assertions)]
    {
        builder = builder.on_page_load(|_, payload| {
            eprintln!("gamecrate: {:?} {}", payload.event(), payload.url());
        });
    }

    builder.build()?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // первым: второй запуск не поднимает остальное, а будит уже открытое окно
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            build_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("GameCrate не запустился");
}
