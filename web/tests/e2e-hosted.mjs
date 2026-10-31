// The end-to-end suite against a hosted server (see e2e.mjs). A separate file so the command works the same on Windows.
process.env.E2E_MODE = "hosted";
await import("./e2e.mjs");
