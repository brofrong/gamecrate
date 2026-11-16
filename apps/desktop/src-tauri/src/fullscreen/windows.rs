//! Windows: только полный экран окна. Win, Alt+Tab и Esc в игру отдаёт страница через
//! `navigator.keyboard.lock()`, если WebView2 его умеет (`apps/web/src/lib/fullscreen.ts`).
//!
//! TODO(задача 3): если проверка на Windows покажет, что `keyboard.lock()` в WebView2 не
//! работает, — низкоуровневый хук `SetWindowsHookExW(WH_KEYBOARD_LL)`, пока окно в фокусе:
//! Win/Alt+Tab/Alt+Esc не уходят в ОС, а передаются странице.

use tauri::{AppHandle, Runtime};

pub fn set_capture<R: Runtime>(_app: &AppHandle<R>, _on: bool) {}
