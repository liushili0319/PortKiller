#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    portkiller_lib::run();
}
