//! Ссылки `gamecrate://` → страница сайта в главном окне.
//!
//! - `gamecrate://auth?token=T` — вход из системного браузера: `<сайт>/login/desktop/finish#token=T`.
//!   Токен во фрагменте: фрагмент не уходит на сервер и в логи прокси/API, страница сама
//!   обменивает его POST-запросом.
//! - `gamecrate://open?path=/app/game/1` — открыть страницу сайта: `<сайт>/app/game/1`.
//!
//! Всё прочее (другой host или схема, кривой путь или токен) — `None`, окно не трогаем.

use tauri::Url;

/// Схема ссылок приложения (та же — в `tauri.conf.json`, `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "gamecrate";

/// Куда вести главное окно по ссылке `url`; `public` — адрес сайта ([`crate::nav::public_url`]).
pub fn target(url: &Url, public: &Url) -> Option<Url> {
    if url.scheme() != SCHEME || !matches!(url.path(), "" | "/") {
        return None;
    }
    let found = match url.host_str()? {
        "auth" => {
            let token = param(url, "token").filter(|t| valid_token(t))?;
            let mut finish = public.join("/login/desktop/finish").ok()?;
            finish.set_fragment(Some(&format!("token={token}")));
            finish
        }
        "open" => {
            let path = param(url, "path").filter(|p| valid_path(p))?;
            public.join(&path).ok()?
        }
        _ => return None,
    };
    crate::nav::is_internal(&found, public).then_some(found)
}

/// Первое значение параметра `name` из query (уже раскодированное).
fn param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// Токен входа: `[A-Za-z0-9_-]{16,256}` — без символов, что меняют смысл URL.
fn valid_token(token: &str) -> bool {
    (16..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Путь сайта: ровно один `/` в начале, без `\`, управляющих символов и схемы.
fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
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

    fn go(s: &str) -> Option<String> {
        target(&url(s), &public()).map(|u| u.to_string())
    }

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

    #[test]
    fn auth_link_goes_to_finish_with_token_in_fragment() {
        assert_eq!(
            go(&format!("gamecrate://auth?token={TOKEN}")).as_deref(),
            Some(format!("https://game.brofrong.ru/login/desktop/finish#token={TOKEN}").as_str())
        );
        // слэш после host тоже допустим (так ссылку пишут некоторые ОС)
        assert_eq!(
            go(&format!("gamecrate://auth/?token={TOKEN}")).as_deref(),
            Some(format!("https://game.brofrong.ru/login/desktop/finish#token={TOKEN}").as_str())
        );
    }

    #[test]
    fn auth_token_never_lands_in_query() {
        let t = target(&url(&format!("gamecrate://auth?token={TOKEN}")), &public()).unwrap();
        assert_eq!(t.query(), None);
        assert_eq!(t.path(), "/login/desktop/finish");
    }

    #[test]
    fn auth_with_dev_site_keeps_its_origin() {
        let dev = url("http://localhost:3000");
        let t = target(&url(&format!("gamecrate://auth?token={TOKEN}")), &dev).unwrap();
        assert_eq!(
            t.as_str(),
            format!("http://localhost:3000/login/desktop/finish#token={TOKEN}")
        );
    }

    #[test]
    fn auth_without_valid_token_is_ignored() {
        for bad in [
            "gamecrate://auth".to_string(),
            "gamecrate://auth?token=".to_string(),
            "gamecrate://auth?other=1".to_string(),
            // короче 16
            "gamecrate://auth?token=short".to_string(),
            // длиннее 256
            format!("gamecrate://auth?token={}", "a".repeat(257)),
            // чужие символы
            "gamecrate://auth?token=abcdefghijklmnop%23x".to_string(),
            "gamecrate://auth?token=abcdefghijklmnop%26next%3D%2F%2Fevil.com".to_string(),
            "gamecrate://auth?token=abcdefgh.ijklmnop".to_string(),
            "gamecrate://auth?token=abcdefgh%20ijklmnop".to_string(),
            // путь после host — не наш формат
            format!("gamecrate://auth/evil?token={TOKEN}"),
        ] {
            assert_eq!(go(&bad), None, "{bad}");
        }
        assert!(go(&format!("gamecrate://auth?token={}", "a".repeat(256))).is_some());
        assert!(go("gamecrate://auth?token=a-b_c-d_e-f_g-h_").is_some());
    }

    #[test]
    fn open_link_goes_to_site_page() {
        assert_eq!(
            go("gamecrate://open?path=/app/game/1").as_deref(),
            Some("https://game.brofrong.ru/app/game/1")
        );
        assert_eq!(
            go("gamecrate://open?path=%2Fapp%2Fcrate").as_deref(),
            Some("https://game.brofrong.ru/app/crate")
        );
        assert_eq!(
            go("gamecrate://open?path=/").as_deref(),
            Some("https://game.brofrong.ru/")
        );
    }

    #[test]
    fn open_rejects_paths_that_could_leave_the_site() {
        for bad in [
            "gamecrate://open",
            "gamecrate://open?path=",
            "gamecrate://open?path=app",
            "gamecrate://open?path=//evil.com/app",
            "gamecrate://open?path=%2F%2Fevil.com",
            "gamecrate://open?path=/%5Cevil.com",
            "gamecrate://open?path=/\\evil.com",
            "gamecrate://open?path=https://evil.com/",
            "gamecrate://open?path=javascript:alert(1)",
            "gamecrate://open?path=/app%0d%0aX",
            "gamecrate://open?path=/app%09x",
            "gamecrate://open?path=/app%00",
        ] {
            assert_eq!(go(bad), None, "{bad}");
        }
    }

    #[test]
    fn other_hosts_and_schemes_are_ignored() {
        for bad in [
            "gamecrate://evil?path=/app",
            "gamecrate://evil.com/?token=AbCdEfGhIjKlMnOpQrSt",
            "gamecrate:auth?token=AbCdEfGhIjKlMnOpQrSt",
            "https://auth?token=AbCdEfGhIjKlMnOpQrSt",
            "https://game.brofrong.ru/app",
            "file:///etc/passwd",
            "gamecrates://open?path=/app",
        ] {
            assert_eq!(go(bad), None, "{bad}");
        }
    }
}
