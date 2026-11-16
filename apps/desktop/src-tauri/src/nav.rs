//! Куда пускать окно: наш сайт — в окне, чужие страницы — в системном браузере.

use tauri::Url;

/// Адрес сайта, зашитый в сборку (`GAMECRATE_URL` при компиляции), как задан — возможно с `/`
/// в конце. Снаружи — только через [`public_base`] и [`public_url`].
const RAW_PUBLIC_URL: &str = match option_env!("GAMECRATE_URL") {
    Some(url) => url,
    None => "https://gamecrate.srv5.wbrofrong.ru",
};

/// Что сделать с переходом окна.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    /// Наш сайт или заглушка из бандла — грузим в окне.
    Allow,
    /// Чужой сайт (или `mailto:`) — отдаём системе, в окне не открываем.
    OpenInBrowser,
    /// Всё прочее (`file:`, `javascript:`, чужой `tauri://`) — молча запрещаем.
    Block,
}

/// Базовый адрес без `/` в конце: `https://gamecrate.srv5.wbrofrong.ru/` → `https://gamecrate.srv5.wbrofrong.ru`.
pub fn trim_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

/// Адрес сайта без `/` в конце.
pub fn public_base() -> &'static str {
    trim_base(RAW_PUBLIC_URL)
}

/// [`public_base`] как `Url`. Кривой адрес в `GAMECRATE_URL` роняет приложение при запуске —
/// сборку с ним сразу видно на первой проверке.
pub fn public_url() -> Url {
    Url::parse(public_base()).expect("GAMECRATE_URL должен быть адресом вида https://host")
}

/// Стартовая страница окна: `<сайт>/app` (гостя сайт сам уведёт на `/login`).
pub fn start_url(base: &str) -> Url {
    Url::parse(&format!("{}/app", trim_base(base)))
        .expect("GAMECRATE_URL должен быть адресом вида https://host")
}

/// Тот же сайт: совпадают схема, хост и порт. Путь не важен (`/api/auth/*` тоже наш).
pub fn is_internal(url: &Url, public: &Url) -> bool {
    url.scheme() == public.scheme()
        && url.host_str() == public.host_str()
        && url.port_or_known_default() == public.port_or_known_default()
}

/// Страница из бандла (заглушка без сети): `tauri://localhost` на macOS и Linux,
/// `http(s)://tauri.localhost` на Windows. На macOS и Linux `tauri.localhost` — обычный
/// loopback, там это был бы чужой локальный сервер, поэтому только Windows и без порта.
fn is_bundled(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            cfg!(windows) && url.host_str() == Some("tauri.localhost") && url.port().is_none()
        }
        _ => false,
    }
}

/// Решение для перехода окна (и фреймов в нём — WKWebView спрашивает и про них).
pub fn decide(url: &Url, public: &Url) -> Nav {
    if is_internal(url, public) || is_bundled(url) {
        return Nav::Allow;
    }
    match url.scheme() {
        // пустые фреймы, которые страница создаёт сама
        "about" if matches!(url.path(), "blank" | "srcdoc") => Nav::Allow,
        // blob: несёт origin создателя — пускаем только свои
        "blob" => match Url::parse(url.path()) {
            Ok(inner) if is_internal(&inner, public) => Nav::Allow,
            _ => Nav::Block,
        },
        "http" | "https" | "mailto" => Nav::OpenInBrowser,
        _ => Nav::Block,
    }
}

/// Путь заглушки в бандле с адресом для кнопки «Повторить».
pub fn offline_query(retry: &Url) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(retry.as_str().as_bytes()).collect();
    format!("index.html?retry={encoded}")
}

/// Адрес для лога: только схема, хост (с портом) и путь. Query и фрагмент отрезаны — в них
/// бывает токен входа (`/login/desktop/finish#token=…`, а на холодном старте по ссылке —
/// `index.html?retry=<адрес с токеном>` у заглушки).
/// У адресов без хоста (`about:`, `data:`) — только схема.
#[cfg(any(debug_assertions, test))]
pub fn loggable(url: &Url) -> String {
    let Some(host) = url.host_str() else {
        return format!("{}:", url.scheme());
    };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}{}", url.scheme(), url.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn public() -> Url {
        url("https://game.brofrong.ru")
    }

    #[test]
    fn own_site_is_internal() {
        assert!(is_internal(&url("https://game.brofrong.ru/app"), &public()));
        assert!(is_internal(
            &url("https://game.brofrong.ru/api/auth/callback/google"),
            &public()
        ));
    }

    #[test]
    fn foreign_hosts_are_external() {
        assert!(!is_internal(
            &url("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
            &public()
        ));
        assert!(!is_internal(
            &url("https://store.steampowered.com/app/1"),
            &public()
        ));
    }

    #[test]
    fn other_scheme_is_external() {
        assert!(!is_internal(&url("http://game.brofrong.ru/"), &public()));
    }

    #[test]
    fn lookalike_host_is_external() {
        assert!(!is_internal(
            &url("https://game.brofrong.ru.evil.com/"),
            &public()
        ));
    }

    #[test]
    fn other_port_is_external() {
        assert!(!is_internal(
            &url("https://game.brofrong.ru:8443/app"),
            &public()
        ));
        assert!(is_internal(
            &url("http://localhost:3000/app"),
            &url("http://localhost:3000")
        ));
        assert!(!is_internal(
            &url("http://localhost:3001/app"),
            &url("http://localhost:3000")
        ));
    }

    #[test]
    fn decide_allows_site_and_bundled_page() {
        assert_eq!(
            decide(&url("https://game.brofrong.ru/app"), &public()),
            Nav::Allow
        );
        // заглушка без сети: tauri://localhost (macOS, Linux), http://tauri.localhost (Windows)
        assert_eq!(
            decide(&url("tauri://localhost/index.html"), &public()),
            Nav::Allow
        );
        let windows_bundle = if cfg!(windows) {
            Nav::Allow
        } else {
            Nav::OpenInBrowser
        };
        assert_eq!(
            decide(&url("http://tauri.localhost/index.html"), &public()),
            windows_bundle
        );
    }

    #[test]
    fn tauri_localhost_with_port_is_not_bundled() {
        assert_eq!(
            decide(&url("http://tauri.localhost:8080/index.html"), &public()),
            Nav::OpenInBrowser
        );
    }

    #[test]
    fn decide_sends_foreign_web_to_browser() {
        assert_eq!(
            decide(&url("https://store.steampowered.com/app/1"), &public()),
            Nav::OpenInBrowser
        );
        assert_eq!(
            decide(&url("http://game.brofrong.ru/"), &public()),
            Nav::OpenInBrowser
        );
        assert_eq!(
            decide(&url("mailto:help@example.com"), &public()),
            Nav::OpenInBrowser
        );
    }

    #[test]
    fn decide_blocks_other_schemes() {
        assert_eq!(decide(&url("file:///etc/passwd"), &public()), Nav::Block);
        assert_eq!(decide(&url("javascript:alert(1)"), &public()), Nav::Block);
        assert_eq!(
            decide(&url("tauri://evil/index.html"), &public()),
            Nav::Block
        );
    }

    #[test]
    fn decide_frames_made_by_own_page() {
        assert_eq!(decide(&url("about:blank"), &public()), Nav::Allow);
        assert_eq!(decide(&url("about:srcdoc"), &public()), Nav::Allow);
        assert_eq!(
            decide(&url("blob:https://game.brofrong.ru/0b7c"), &public()),
            Nav::Allow
        );
        assert_eq!(
            decide(&url("blob:https://evil.com/0b7c"), &public()),
            Nav::Block
        );
        assert_eq!(
            decide(&url("data:text/html,<h1>x</h1>"), &public()),
            Nav::Block
        );
    }

    #[test]
    fn public_url_has_no_trailing_slash() {
        assert_eq!(
            trim_base("https://game.brofrong.ru/"),
            "https://game.brofrong.ru"
        );
        assert_eq!(trim_base("http://localhost:3000"), "http://localhost:3000");
        assert_eq!(
            start_url("https://game.brofrong.ru//").as_str(),
            "https://game.brofrong.ru/app"
        );
    }

    #[test]
    fn offline_page_carries_retry_url() {
        let page = offline_query(&url("https://game.brofrong.ru/app"));
        assert_eq!(
            page,
            "index.html?retry=https%3A%2F%2Fgame.brofrong.ru%2Fapp"
        );
    }

    #[test]
    fn loggable_url_drops_query_and_fragment() {
        let token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        let finish = url(&format!(
            "https://game.brofrong.ru/login/desktop/finish#token={token}&state=s"
        ));
        assert_eq!(
            loggable(&finish),
            "https://game.brofrong.ru/login/desktop/finish"
        );
        // холодный старт по ссылке: адрес с токеном лежит в `?retry=` заглушки
        let offline = url(&format!("tauri://localhost/{}", offline_query(&finish)));
        let shown = loggable(&offline);
        assert_eq!(shown, "tauri://localhost/index.html");
        assert!(!shown.contains(token));
        assert_eq!(
            loggable(&url("http://localhost:3000/app?x=1")),
            "http://localhost:3000/app"
        );
        assert_eq!(
            loggable(&url("https://user:pw@game.brofrong.ru/app")),
            "https://game.brofrong.ru/app"
        );
    }
}
