// What goes into a QR code and what a scanned one means. Run with: npm run test:unit
import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, parseScanned, EMPTY_FORM, normalizeUrl, contrast, isInverted, fileNameFor } from "../src/lib/qr.ts";

const form = (patch) => ({ ...EMPTY_FORM, ...patch });

test("links get https:// when typed bare, and keep their own scheme", () => {
  assert.equal(normalizeUrl("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeUrl("  http://x.fr "), "http://x.fr");
  assert.equal(buildPayload("url", form({ url: "" })).text, null);
  assert.ok(buildPayload("url", form({ url: "exa mple.com" })).problem);
});

test("Wi-Fi codes escape special characters and need a valid password", () => {
  const wifi = { ssid: 'Café;Home', password: 'p@ss:w"rd', security: "WPA", hidden: true };
  const p = buildPayload("wifi", form({ wifi }));
  assert.equal(p.text, 'WIFI:T:WPA;S:Café\\;Home;P:p@ss\\:w\\"rd;H:true;;');
  const back = parseScanned(p.text);
  assert.deepEqual(back, { kind: "wifi", ssid: "Café;Home", password: 'p@ss:w"rd', security: "WPA", hidden: true });
  assert.ok(buildPayload("wifi", form({ wifi: { ...wifi, password: "short" } })).problem);
  assert.ok(buildPayload("wifi", form({ wifi: { ...wifi, password: "" } })).problem);
  const open = buildPayload("wifi", form({ wifi: { ssid: "Guest", password: "ignored", security: "nopass", hidden: false } }));
  assert.equal(open.text, "WIFI:T:nopass;S:Guest;;");
  assert.equal(parseScanned(open.text).security, "nopass");
});

test("contacts become a vCard that reads back", () => {
  const contact = { ...EMPTY_FORM.contact, first: "Amine", last: "El Idrissi", phone: "+33 6 12 34 56 78", email: "a@b.fr", org: "Orange, File", website: "orangefile.app" };
  const p = buildPayload("contact", form({ contact }));
  assert.match(p.text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nN:El Idrissi;Amine;;;\r\nFN:Amine El Idrissi\r\n/);
  assert.match(p.text, /TEL;TYPE=CELL:\+33612345678/);
  assert.match(p.text, /ORG:Orange\\, File/);
  assert.match(p.text, /URL:https:\/\/orangefile\.app/);
  const back = parseScanned(p.text);
  assert.equal(back.kind, "contact");
  assert.deepEqual(back.fields[0], { label: "Name", value: "Amine El Idrissi" });
  assert.ok(back.fields.some((f) => f.label === "Organisation" && f.value === "Orange, File"));
  assert.equal(buildPayload("contact", form()).text, null);
});

test("email, phone and SMS", () => {
  const e = buildPayload("email", form({ email: { to: "hi@x.fr", subject: "Bonjour & merci", body: "Ligne 1\nLigne 2" } }));
  assert.equal(e.text, "mailto:hi@x.fr?subject=Bonjour%20%26%20merci&body=Ligne%201%0ALigne%202");
  assert.deepEqual(parseScanned(e.text), { kind: "email", to: "hi@x.fr", subject: "Bonjour & merci", body: "Ligne 1\nLigne 2" });
  assert.ok(buildPayload("email", form({ email: { to: "nope", subject: "", body: "" } })).problem);
  assert.equal(buildPayload("phone", form({ phone: "+33 (0)6 12" })).text, "tel:+33612");
  const s = buildPayload("sms", form({ sms: { number: "06 12", message: "Salut: ça va ?" } }));
  assert.equal(s.text, "SMSTO:0612:Salut: ça va ?");
  assert.deepEqual(parseScanned(s.text), { kind: "sms", number: "0612", message: "Salut: ça va ?" });
});

test("scanned text is recognised", () => {
  assert.deepEqual(parseScanned("https://www.example.com/a b"), { kind: "text" });
  const u = parseScanned("https://www.example.com/path?q=1");
  assert.equal(u.kind, "url");
  assert.equal(u.host, "www.example.com");
  assert.equal(parseScanned("www.orangefile.app").kind, "url");
  assert.equal(parseScanned("javascript:alert(1)").kind, "text", "only http(s) links are offered as links");
  assert.deepEqual(parseScanned("geo:48.8566,2.3522"), { kind: "geo", lat: 48.8566, lon: 2.3522 });
  assert.equal(parseScanned("geo:200,2").kind, "text");
  assert.deepEqual(parseScanned("tel:+33612"), { kind: "phone", number: "+33612" });
  assert.equal(parseScanned("MECARD:N:Doe,John;TEL:123;;").fields[0].value, "John Doe");
  assert.deepEqual(parseScanned("Juste du texte"), { kind: "text" });
});

test("colour checks", () => {
  assert.ok(contrast("#000000", "#ffffff") > 20);
  assert.ok(contrast("#777777", "#888888") < 1.5);
  assert.equal(isInverted("#ffffff", "#000000"), true);
  assert.equal(isInverted("#111111", "#ffffff"), false);
});

test("file names come from the content", () => {
  assert.equal(fileNameFor("url", form({ url: "www.orangefile.app/x" })), "qr-orangefile.app");
  assert.equal(fileNameFor("wifi", form({ wifi: { ...EMPTY_FORM.wifi, ssid: 'Box:"5G"' } })), "qr-wifi-Box5G");
  assert.equal(fileNameFor("text", form()), "qr-text");
});
