#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(debug_assertions)]
    if let Some(code) = codex_app_manager_lib::smoke_mode() {
        std::process::exit(code);
    }
    if let Some(code) = codex_app_manager_lib::credential_mode() {
        std::process::exit(code);
    }
    codex_app_manager_lib::run()
}
