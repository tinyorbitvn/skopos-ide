//! IPC commands. Each delegates to `AppCore`. They are async so that the file
//! writes behind them run off the main thread, which would otherwise freeze the UI.

pub mod access;
pub mod actions;
pub mod agents;
pub mod app;
pub mod argocd;
pub mod catalog;
pub mod cluster;
pub mod graph;
pub mod helm;
pub mod logs;
pub mod map;
pub mod metrics;
pub mod network;
pub mod portforward;
pub mod resources;
pub(crate) mod save;
pub mod sessions;
pub mod settings;
pub mod tools;
pub mod topology;
pub mod updates;
pub mod windows;
