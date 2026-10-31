//! Open PDF documents: each upload lives in its own private folder until it is closed,
//! evicted, idle for too long, or the server shuts down.

use file_core::pdf::PdfInfo;
use file_core::request::Secret;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Rendered pages kept on disk per document before the cache is cleared.
const MAX_CACHED_RENDERS: usize = 400;

pub struct Doc {
    pub id: String,
    /// The principal that opened it; nobody else may use it.
    pub owner: String,
    pub dir: PathBuf,
    /// Display name the client sent.
    pub name: String,
    pub size: u64,
    /// Held in memory only, to reopen the file for each render; never written anywhere.
    pub password: Option<Secret>,
    pub info: PdfInfo,
    last_used: Mutex<Instant>,
    renders: AtomicUsize,
}

impl Doc {
    pub fn new(id: String, owner: String, dir: PathBuf, name: String, size: u64, password: Option<Secret>, info: PdfInfo) -> Self {
        Self { id, owner, dir, name, size, password, info, last_used: Mutex::new(Instant::now()), renders: AtomicUsize::new(0) }
    }

    pub fn source(&self) -> PathBuf {
        self.dir.join("source.pdf")
    }

    pub fn render_dir(&self) -> PathBuf {
        self.dir.join("render")
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    /// Count a new cached render; true when the cache has grown past its bound and should be emptied.
    pub fn note_render(&self) -> bool {
        self.renders.fetch_add(1, Ordering::SeqCst) + 1 > MAX_CACHED_RENDERS
    }

    pub fn reset_renders(&self) {
        self.renders.store(0, Ordering::SeqCst);
    }
}

pub struct DocStore {
    docs: RwLock<HashMap<String, Arc<Doc>>>,
    max_open: usize,
}

impl DocStore {
    pub fn new(max_open: usize) -> Self {
        Self { docs: RwLock::new(HashMap::new()), max_open: max_open.max(1) }
    }

    /// Add a document; returns the folders of any documents closed to make room. An owner at their own limit loses
    /// their own least recently used document first, so one visitor can never push out another's.
    pub fn insert(&self, doc: Arc<Doc>, per_owner: usize) -> Vec<PathBuf> {
        let mut docs = self.docs.write().unwrap();
        let mut closed = Vec::new();
        loop {
            let mine = docs.values().filter(|d| d.owner == doc.owner).count();
            if mine < per_owner.max(1) {
                break;
            }
            let Some(oldest) = docs.values().filter(|d| d.owner == doc.owner).max_by_key(|d| d.idle_for()).map(|d| d.id.clone()) else { break };
            if let Some(d) = docs.remove(&oldest) {
                closed.push(d.dir.clone());
            }
        }
        while docs.len() >= self.max_open {
            let Some(oldest) = docs.values().max_by_key(|d| d.idle_for()).map(|d| d.id.clone()) else { break };
            if let Some(d) = docs.remove(&oldest) {
                closed.push(d.dir.clone());
            }
        }
        docs.insert(doc.id.clone(), doc);
        closed
    }

    /// The document, if it exists and belongs to `owner`. Someone else's document is indistinguishable from a missing one.
    pub fn get(&self, id: &str, owner: &str) -> Option<Arc<Doc>> {
        let doc = self.docs.read().unwrap().get(id).cloned()?;
        if doc.owner != owner {
            return None;
        }
        doc.touch();
        Some(doc)
    }

    pub fn remove(&self, id: &str, owner: &str) -> Option<PathBuf> {
        let mut docs = self.docs.write().unwrap();
        if docs.get(id).is_some_and(|d| d.owner != owner) {
            return None;
        }
        docs.remove(id).map(|d| d.dir.clone())
    }

    pub fn take_idle(&self, idle: Duration) -> Vec<PathBuf> {
        let mut docs = self.docs.write().unwrap();
        let stale: Vec<String> = docs.values().filter(|d| d.idle_for() >= idle).map(|d| d.id.clone()).collect();
        stale.into_iter().filter_map(|id| docs.remove(&id)).map(|d| d.dir.clone()).collect()
    }

    pub fn drain(&self) -> Vec<PathBuf> {
        self.docs.write().unwrap().drain().map(|(_, d)| d.dir.clone()).collect()
    }
}
