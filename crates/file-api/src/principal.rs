//! Who is making a request. In the desktop app there is exactly one, `local`. A hosted server gives every visitor
//! their own id, and every job and open document belongs to the id that created it: anyone else gets "not found".

use std::net::IpAddr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// The desktop app talking to its own engine: no limits beyond the engine's.
    Local,
    /// A visitor to a hosted server, with limits.
    Anonymous,
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub id: String,
    pub tier: Tier,
    /// Where the request came from, when the server knows (hosted mode).
    pub ip: Option<IpAddr>,
}

impl Principal {
    pub fn local() -> Self {
        Self { id: "local".into(), tier: Tier::Local, ip: None }
    }
}
