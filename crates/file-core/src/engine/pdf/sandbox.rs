//! Limits placed on the PDF worker process, per platform.
//!
//! - Unix: an address-space cap (`RLIMIT_AS`, unless the cap is 0), no core dumps, and the worker dies if the app does.
//! - Windows: the worker is put in a Job Object with a per-process memory cap that is
//!   killed when the app closes it, and it gets no console window. The Windows branch is
//!   type-checked for the Windows target but has not been run on Windows by this repository's
//!   tests; see ARCHITECTURE.md.

use std::process::{Child, Command};

/// Dropping the guard kills the worker on Windows (job closed) and is a no-op elsewhere.
pub struct Guard {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

/// For programs that start helpers of their own (LibreOffice): put the program in its own process group
/// (Unix) so the whole tree can be stopped with [`kill_tree`]. On Windows the Job Object from [`attach`] does that.
#[cfg(unix)]
pub fn own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
pub fn own_group(_cmd: &mut Command) {}

/// Stop the program and everything it started.
pub fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    // SAFETY: plain kill(2) on the process group this program created for the child.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
pub fn prepare(cmd: &mut Command, memory_bytes: u64) {
    use std::os::unix::process::CommandExt;
    let mem = memory_bytes as libc::rlim_t;
    // SAFETY: the closure runs between fork and exec and only calls async-signal-safe
    // functions (setrlimit, prctl) on values copied into it; it allocates nothing.
    unsafe {
        cmd.pre_exec(move || {
            if mem != 0 {
                let cap = libc::rlimit { rlim_cur: mem, rlim_max: mem };
                libc::setrlimit(libc::RLIMIT_AS, &cap);
            }
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            libc::setrlimit(libc::RLIMIT_CORE, &none);
            #[cfg(target_os = "linux")]
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0);
            Ok(())
        });
    }
}

#[cfg(unix)]
pub fn attach(_child: &Child, _memory_bytes: u64) -> Guard {
    Guard {}
}

#[cfg(windows)]
pub fn prepare(cmd: &mut Command, _memory_bytes: u64) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
pub fn attach(child: &Child, memory_bytes: u64) -> Guard {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::*;
    // The worker starts running before it joins the job, so the cap applies from its first
    // few milliseconds on, not its first instruction. A job that can't be made leaves the
    // worker running with only the timeout as protection.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Guard { job: std::ptr::null_mut() };
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if memory_bytes != 0 {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = memory_bytes as usize;
        }
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            windows_sys::Win32::Foundation::CloseHandle(job);
            return Guard { job: std::ptr::null_mut() };
        }
        Guard { job }
    }
}

#[cfg(windows)]
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub fn prepare(_cmd: &mut Command, _memory_bytes: u64) {}
#[cfg(not(any(unix, windows)))]
pub fn attach(_child: &Child, _memory_bytes: u64) -> Guard {
    Guard {}
}
