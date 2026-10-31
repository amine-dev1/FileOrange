//! Records the exact versions of the libraries behind each engine, read from the
//! workspace Cargo.lock, so the app can report real engine versions at run time.

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let lock = manifest.ancestors().map(|d| d.join("Cargo.lock")).find(|p| p.exists());
    let text = lock.as_ref().and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
    if let Some(p) = &lock {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    println!("cargo:rerun-if-changed=build.rs");

    for (crate_name, var) in [("zip", "FC_VER_ZIP"), ("image", "FC_VER_IMAGE"), ("webp", "FC_VER_WEBP_CRATE"), ("libwebp-sys", "FC_VER_LIBWEBP_SYS"), ("lopdf", "FC_VER_LOPDF")] {
        let mut version = "unknown".to_string();
        let mut lines = text.lines();
        while let Some(l) = lines.next() {
            if l.trim() == format!("name = \"{crate_name}\"") {
                if let Some(v) = lines.next().and_then(|v| v.trim().strip_prefix("version = \"")).and_then(|v| v.strip_suffix('"')) {
                    version = v.to_string();
                }
                break;
            }
        }
        println!("cargo:rustc-env={var}={version}");
    }
}
