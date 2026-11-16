//! Linux: только полный экран окна. Запрет системных сочетаний зависит от композитора (под
//! Wayland полного перехвата нет) — решаем по итогам проверки на Linux (задача 3).

use tauri::{AppHandle, Runtime};

pub fn set_capture<R: Runtime>(_app: &AppHandle<R>, _on: bool) {}
