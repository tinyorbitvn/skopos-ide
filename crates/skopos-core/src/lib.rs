pub mod agents;
pub mod app_core;
pub mod app_info;
pub mod blocking;
pub mod catalog;
pub mod cluster;
pub mod error;
pub mod external_url;
pub mod graph;
pub mod helm;
pub mod kubeconfig;
pub mod map_export;
pub mod metrics;
pub mod navigation;
pub mod openapi;
pub mod paths;
pub mod portforward;
pub mod prefs;
pub mod process;
pub mod quit;
pub mod resources;
pub mod save_file;
pub mod secrets;
pub mod sessions;
pub mod shell_env;
pub mod store;
mod subscriptions;
pub mod tools;
pub mod topology;
pub mod ui_state;
pub mod updates;
pub mod windows;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!super::VERSION.is_empty());
    }
}
