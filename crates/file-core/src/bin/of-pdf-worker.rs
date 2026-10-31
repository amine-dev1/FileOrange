//! Stand-alone PDF worker, used by file-core's tests (any arguments are ignored). The desktop app and the
//! `file-api` binary run the same code by re-invoking themselves with `--pdf-worker`.
fn main() {
    std::process::exit(file_core::pdf::worker::main());
}
