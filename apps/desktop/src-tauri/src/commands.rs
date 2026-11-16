//! Команды для страниц сайта (мост `apps/web/src/lib/desktop.ts`) и права на них.
//!
//! Права выдаются в рантайме ([`site_capability`]), а не файлом `capabilities/*.json`: адрес
//! сайта зашит в сборку (`GAMECRATE_URL`, [`crate::nav::public_base`]), и статический файл с
//! `game.brofrong.ru` разошёлся бы с ним (dev-сборка на `http://localhost:3000`, стенд).
//! Команды приложения объявлены в build.rs (`AppManifest`): с ним Tauri проверяет ACL у каждой
//! команды, и страница из бандла (заглушка без сети) не получает ничего.

use crate::status::{AppState, Status};
use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Runtime, State, Url, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Команды моста — те же, что в build.rs.
pub const BRIDGE_COMMANDS: [&str; 6] = [
    "notify",
    "set_status",
    "enter_game_fullscreen",
    "exit_game_fullscreen",
    "open_external",
    "app_info",
];

/// Права страниц сайта `<base>/*` в окне `main`: только команды моста, никаких плагинов
/// (fs, shell, http, opener, notification — всё это делает Rust по команде, а не страница).
pub fn site_capability(base: &str) -> CapabilityBuilder {
    BRIDGE_COMMANDS.iter().fold(
        CapabilityBuilder::new("site")
            .remote(format!("{}/*", crate::nav::trim_base(base)))
            .local(false)
            .window(crate::MAIN),
        |cap, command| cap.permission(format!("allow-{}", command.replace('_', "-"))),
    )
}

/// Адрес для `open_external`: только `https://` с хостом.
pub fn external_url(raw: &str) -> Result<Url, String> {
    match Url::parse(raw) {
        Ok(url) if url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty()) => {
            Ok(url)
        }
        _ => Err("open_external: нужен адрес https://".into()),
    }
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    version: &'static str,
    /// `windows` | `macos` | `linux` — как ждёт сайт.
    os: &'static str,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
    }
}

#[tauri::command]
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let url = external_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn notify<R: Runtime>(app: AppHandle<R>, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_status<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, status: Status) {
    if state.replace_status(status.clone()) != status {
        crate::tray::update(&app, &status);
    }
}

/// Игровой полный экран окна, из которого позвали (права — только у `main`).
#[tauri::command]
pub fn enter_game_fullscreen<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    crate::fullscreen::enter(&window).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn exit_game_fullscreen<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    crate::fullscreen::exit(&window).map_err(|err| err.to_string())
}

/// Обработчик команд моста.
pub fn handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        notify,
        set_status,
        enter_game_fullscreen,
        exit_game_fullscreen,
        open_external,
        app_info
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn external_accepts_only_https() {
        assert_eq!(
            external_url("https://store.steampowered.com/app/1")
                .unwrap()
                .as_str(),
            "https://store.steampowered.com/app/1"
        );
        for bad in [
            "http://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "gamecrate://open?path=/app",
            "smb://host/share",
            "/app",
            "",
            "https://",
        ] {
            assert!(external_url(bad).is_err(), "{bad} должен быть отклонён");
        }
    }

    /// Приложение на мок-рантайме с настоящим ACL сборки (`generate_context!` + build.rs) и
    /// правами сайта `https://game.brofrong.ru`.
    fn mock_app() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_deep_link::init())
            .manage(AppState::default())
            .invoke_handler(handler())
            .build(crate::context())
            .expect("мок-приложение");
        app.add_capability(site_capability("https://game.brofrong.ru"))
            .expect("права сайта");
        let window = WebviewWindowBuilder::new(&app, crate::MAIN, WebviewUrl::default())
            .build()
            .expect("окно");
        // приложение должно жить, пока жив тест
        std::mem::forget(app);
        window
    }

    fn invoke(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        from: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: from.parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
    }

    fn denied(result: &Result<serde_json::Value, serde_json::Value>) -> bool {
        matches!(result, Err(e) if e.as_str().is_some_and(|s| s.contains("not allowed")))
    }

    #[test]
    fn site_page_can_call_bridge_commands() {
        let window = mock_app();
        let info = invoke(
            &window,
            "app_info",
            "https://game.brofrong.ru/app?tab=1#x",
            serde_json::json!({}),
        )
        .expect("app_info с сайта");
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        // ошибка самой команды, а не ACL
        let bad = invoke(
            &window,
            "open_external",
            "https://game.brofrong.ru/app/game/1",
            serde_json::json!({ "url": "file:///etc/passwd" }),
        );
        assert!(bad.is_err() && !denied(&bad), "{bad:?}");
    }

    #[test]
    fn site_page_toggles_game_fullscreen() {
        use std::sync::atomic::Ordering;
        let window = mock_app();
        let active = || {
            window
                .state::<AppState>()
                .game_fullscreen
                .load(Ordering::SeqCst)
        };
        let from = "https://game.brofrong.ru/app/session/1";
        invoke(
            &window,
            "enter_game_fullscreen",
            from,
            serde_json::json!({}),
        )
        .expect("вход с сайта");
        assert!(active());
        invoke(&window, "exit_game_fullscreen", from, serde_json::json!({}))
            .expect("выход с сайта");
        assert!(!active());
        // повторный выход — не ошибка
        invoke(&window, "exit_game_fullscreen", from, serde_json::json!({}))
            .expect("повторный выход");
        let foreign = invoke(
            &window,
            "enter_game_fullscreen",
            "https://evil.com/",
            serde_json::json!({}),
        );
        assert!(denied(&foreign), "{foreign:?}");
        assert!(!active());
    }

    #[test]
    fn foreign_pages_get_nothing() {
        let window = mock_app();
        for from in [
            "https://evil.com/",
            "https://game.brofrong.ru.evil.com/app",
            "http://game.brofrong.ru/app",
            "https://game.brofrong.ru:8443/app",
            "https://store.steampowered.com/app/1",
            // заглушка без сети из бандла — тоже без команд
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            let result = invoke(&window, "app_info", from, serde_json::json!({}));
            assert!(denied(&result), "{from}: {result:?}");
        }
    }

    #[test]
    fn site_page_gets_no_plugin_commands() {
        let window = mock_app();
        let result = invoke(
            &window,
            "plugin:opener|open_url",
            "https://game.brofrong.ru/app",
            serde_json::json!({ "url": "https://evil.com/" }),
        );
        assert!(denied(&result), "{result:?}");
        let _ = window.app_handle();
    }

    #[test]
    fn site_page_gets_no_deep_link_commands() {
        let window = mock_app();
        for cmd in [
            "plugin:deep-link|get_current",
            "plugin:deep-link|register",
            "plugin:deep-link|unregister",
            "plugin:deep-link|is_registered",
        ] {
            let result = invoke(
                &window,
                cmd,
                "https://game.brofrong.ru/app",
                serde_json::json!({ "protocol": "gamecrate" }),
            );
            assert!(denied(&result), "{cmd}: {result:?}");
        }
    }

    #[test]
    fn site_capability_lists_only_bridge_commands() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(cap) = site_capability("http://localhost:3000").build()
        else {
            panic!("одна капабилити");
        };
        assert_eq!(
            cap.remote.expect("remote").urls,
            vec!["http://localhost:3000/*".to_string()]
        );
        assert!(!cap.local, "страницам из бандла команд нет");
        assert_eq!(cap.windows, vec![crate::MAIN.to_string()]);
        let mut permissions: Vec<String> = cap
            .permissions
            .iter()
            .map(|p| p.identifier().get().to_string())
            .collect();
        permissions.sort();
        assert_eq!(
            permissions,
            [
                "allow-app-info",
                "allow-enter-game-fullscreen",
                "allow-exit-game-fullscreen",
                "allow-notify",
                "allow-open-external",
                "allow-set-status",
            ]
        );
    }
}
