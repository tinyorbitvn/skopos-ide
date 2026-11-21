//! Which pages a window may load. Every command is open to whatever page a window shows, so
//! a window that left the app's own pages would hand them to that page.

use url::Url;

/// Whether `url` is one of the app's own pages: the bundled interface, a blank page, or the
/// development server at `dev` when the app runs from one.
pub fn stays_in_app(url: &Url, dev: Option<&Url>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    // An origin with no host, such as a `data:` page's, equals no other.
    if dev.is_some_and(|dev| url.origin() == dev.origin()) {
        return true;
    }
    // The bundled interface is served under `tauri:` or, where the webview cannot register
    // a scheme, under a host that only the app answers for.
    let host = match url.scheme() {
        "tauri" => "localhost",
        "http" | "https" => "tauri.localhost",
        _ => return false,
    };
    url.host_str() == Some(host) && url.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stays(raw: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|dev| Url::parse(dev).unwrap());
        stays_in_app(&Url::parse(raw).unwrap(), dev.as_ref())
    }

    #[test]
    fn the_bundled_interface_and_a_blank_page_stay() {
        for own in [
            "tauri://localhost",
            "tauri://localhost/index.html#/cluster/abc/pods",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(stays(own, None), "{own}");
        }
    }

    #[test]
    fn any_other_page_is_refused() {
        for other in [
            "https://example.com/",
            "http://localhost:5173/",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
            "about:srcdoc",
            "tauri://evil.example/",
            "tauri://localhost:9000/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://tauri.localhost@evil.example/",
            "ftp://tauri.localhost/",
        ] {
            assert!(!stays(other, None), "{other}");
        }
    }

    #[test]
    fn the_development_server_stays_only_while_it_is_named() {
        let dev = Some("http://localhost:5173");
        assert!(stays("http://localhost:5173/", dev));
        assert!(stays("http://localhost:5173/src/main.tsx?t=1#/x", dev));
        assert!(stays("tauri://localhost/", dev));

        assert!(!stays("http://localhost:5174/", dev));
        assert!(!stays("https://localhost:5173/", dev));
        assert!(!stays("http://localhost.evil.example:5173/", dev));
        assert!(!stays("https://example.com/", dev));
    }
}
