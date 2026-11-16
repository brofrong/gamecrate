fn main() {
    // адрес сайта зашит в сборку (`option_env!` в nav.rs) — пересобрать, если его сменили
    println!("cargo:rerun-if-env-changed=GAMECRATE_URL");
    tauri_build::build()
}
