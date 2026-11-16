fn main() {
    // адрес сайта зашит в сборку (`option_env!` в nav.rs) — пересобрать, если его сменили
    println!("cargo:rerun-if-env-changed=GAMECRATE_URL");
    // Команды моста (тот же список — `commands::BRIDGE_COMMANDS`). С манифестом Tauri проверяет
    // ACL у каждой команды приложения: зовут их только страницы с правами из
    // `commands::site_capability`, страница из бандла — нет.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify",
            "set_status",
            "enter_game_fullscreen",
            "exit_game_fullscreen",
            "open_external",
            "app_info",
        ]),
    ))
    .expect("tauri-build")
}
