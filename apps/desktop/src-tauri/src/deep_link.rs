//! Ссылки `gamecrate://` → страница сайта в главном окне.
//!
//! - `gamecrate://auth?token=T&state=S` — вход из системного браузера:
//!   `<сайт>/login/desktop/finish#token=T&state=S`. Токен во фрагменте: фрагмент не уходит на
//!   сервер и в логи прокси/API, страница сама обменивает его POST-запросом. `state` обязателен:
//!   его создало окно приложения перед открытием браузера, страница сверит его со своим
//!   `sessionStorage` — так чужая ссылка не войдёт в приложение под чужой учёткой (login CSRF).
//! - `gamecrate://open?path=/app/game/1` — открыть страницу сайта: `<сайт>/app/game/1`.
//!
//! Всё прочее (другой host или схема, userinfo или порт, кривой путь, токен или `state`) —
//! `None`, окно не трогаем.

use tauri::Url;

/// Схема ссылок приложения (та же — в `tauri.conf.json`, `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "gamecrate";

/// Куда вести главное окно по ссылке `url`; `public` — адрес сайта ([`crate::nav::public_url`]).
pub fn target(url: &Url, public: &Url) -> Option<Url> {
    if url.scheme() != SCHEME
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let found = match url.host_str()? {
        "auth" => {
            let token = param(url, "token").filter(|t| valid_token(t))?;
            let state = param(url, "state").filter(|s| valid_state(s))?;
            let mut finish = public.join("/login/desktop/finish").ok()?;
            finish.set_fragment(Some(&format!("token={token}&state={state}")));
            finish
        }
        "open" => {
            let path = param(url, "path").filter(|p| valid_path(p))?;
            let page = public.join(&path).ok()?;
            // `/..//x` после схлопывания `..` даёт путь `//x`
            if page.path().starts_with("//") {
                return None;
            }
            page
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
    url_safe(token, 16..=256)
}

/// `state` окна, начавшего вход: `[A-Za-z0-9_-]{16,128}` (тот же формат проверяет сайт).
fn valid_state(state: &str) -> bool {
    url_safe(state, 16..=128)
}

/// Строка из `[A-Za-z0-9_-]` длиной из `len`.
fn url_safe(value: &str, len: std::ops::RangeInclusive<usize>) -> bool {
    len.contains(&value.len())
        && value
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
    const STATE: &str = "s7a_Te-0123456789abcdefghijklmnopqrstuvwxyz";

    fn finish() -> String {
        format!("https://game.brofrong.ru/login/desktop/finish#token={TOKEN}&state={STATE}")
    }

    #[test]
    fn auth_link_goes_to_finish_with_token_and_state_in_fragment() {
        assert_eq!(
            go(&format!("gamecrate://auth?token={TOKEN}&state={STATE}")),
            Some(finish())
        );
        // порядок параметров не важен
        assert_eq!(
            go(&format!("gamecrate://auth?state={STATE}&token={TOKEN}")),
            Some(finish())
        );
        // слэш после host тоже допустим (так ссылку пишут некоторые ОС)
        assert_eq!(
            go(&format!("gamecrate://auth/?token={TOKEN}&state={STATE}")),
            Some(finish())
        );
    }

    #[test]
    fn auth_token_never_lands_in_query() {
        let t = target(
            &url(&format!("gamecrate://auth?token={TOKEN}&state={STATE}")),
            &public(),
        )
        .unwrap();
        assert_eq!(t.query(), None);
        assert_eq!(t.path(), "/login/desktop/finish");
    }

    #[test]
    fn auth_with_dev_site_keeps_its_origin() {
        let dev = url("http://localhost:3000");
        let t = target(
            &url(&format!("gamecrate://auth?token={TOKEN}&state={STATE}")),
            &dev,
        )
        .unwrap();
        assert_eq!(
            t.as_str(),
            format!("http://localhost:3000/login/desktop/finish#token={TOKEN}&state={STATE}")
        );
    }

    #[test]
    fn auth_without_valid_token_is_ignored() {
        for bad in [
            format!("gamecrate://auth?state={STATE}"),
            format!("gamecrate://auth?token=&state={STATE}"),
            format!("gamecrate://auth?other=1&state={STATE}"),
            // короче 16
            format!("gamecrate://auth?token=short&state={STATE}"),
            // длиннее 256
            format!("gamecrate://auth?token={}&state={STATE}", "a".repeat(257)),
            // чужие символы
            format!("gamecrate://auth?token=abcdefghijklmnop%23x&state={STATE}"),
            format!(
                "gamecrate://auth?token=abcdefghijklmnop%26next%3D%2F%2Fevil.com&state={STATE}"
            ),
            format!("gamecrate://auth?token=abcdefgh.ijklmnop&state={STATE}"),
            format!("gamecrate://auth?token=abcdefgh%20ijklmnop&state={STATE}"),
            // путь после host — не наш формат
            format!("gamecrate://auth/evil?token={TOKEN}&state={STATE}"),
        ] {
            assert_eq!(go(&bad), None, "{bad}");
        }
        assert!(go(&format!(
            "gamecrate://auth?token={}&state={STATE}",
            "a".repeat(256)
        ))
        .is_some());
        assert!(go(&format!(
            "gamecrate://auth?token=a-b_c-d_e-f_g-h_&state={STATE}"
        ))
        .is_some());
    }

    #[test]
    fn auth_without_valid_state_is_ignored() {
        for bad in [
            // без state — вход не привязан к окну, которое его начало (login CSRF)
            format!("gamecrate://auth?token={TOKEN}"),
            format!("gamecrate://auth?token={TOKEN}&state="),
            // короче 16
            format!("gamecrate://auth?token={TOKEN}&state=short"),
            // длиннее 128
            format!("gamecrate://auth?token={TOKEN}&state={}", "s".repeat(129)),
            // чужие символы
            format!("gamecrate://auth?token={TOKEN}&state=abcdefghijklmnop%23x"),
            format!("gamecrate://auth?token={TOKEN}&state=abcdefghijklmnop%26token%3Dx"),
            format!("gamecrate://auth?token={TOKEN}&state=abcdefgh.ijklmnop"),
            format!("gamecrate://auth?token={TOKEN}&state=abcdefgh%20ijklmnop"),
        ] {
            assert_eq!(go(&bad), None, "{bad}");
        }
        assert!(go(&format!(
            "gamecrate://auth?token={TOKEN}&state={}",
            "s".repeat(128)
        ))
        .is_some());
        assert!(go(&format!(
            "gamecrate://auth?token={TOKEN}&state={}",
            "s".repeat(16)
        ))
        .is_some());
    }

    #[test]
    fn auth_with_userinfo_or_port_is_ignored() {
        for bad in [
            format!("gamecrate://x@auth?token={TOKEN}&state={STATE}"),
            format!("gamecrate://x:y@auth?token={TOKEN}&state={STATE}"),
            format!("gamecrate://auth:1?token={TOKEN}&state={STATE}"),
        ] {
            assert_eq!(go(&bad), None, "{bad}");
        }
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
            "gamecrate://open?path=https://evil.com",
            "gamecrate://open?path=javascript:alert(1)",
            "gamecrate://open?path=/app%0d%0aX",
            "gamecrate://open?path=/app%09x",
            "gamecrate://open?path=/app%00",
            "gamecrate://x@open?path=/app",
            "gamecrate://open:1?path=/app",
        ] {
            assert_eq!(go(bad), None, "{bad}");
        }
    }

    #[test]
    fn open_dot_segments_stay_on_the_site() {
        // `..` у корня схлопывается в `//evil.com` — хост свой, но путь с `//` (в `next` это
        // открытый редирект), поэтому `None`
        assert_eq!(go("gamecrate://open?path=/..//evil.com"), None);
        assert_eq!(go("gamecrate://open?path=/app/..//evil.com"), None);
        // просто `..` — своя страница
        assert_eq!(
            go("gamecrate://open?path=/app/../../evil.com").as_deref(),
            Some("https://game.brofrong.ru/evil.com")
        );
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
