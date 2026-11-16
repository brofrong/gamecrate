// В релизной сборке на Windows — без окна консоли.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gamecrate_desktop_lib::run()
}
