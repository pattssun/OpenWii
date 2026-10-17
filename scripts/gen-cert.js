'use strict';

/**
 * Self-signed cert generator using Node's built-in crypto APIs.
 *
 * Why this exists: DeviceOrientationEvent.requestPermission() only resolves in a
 * secure context. `http://192.168.x.x` is NOT a secure context, so a plain-HTTP
 * LAN server can never read the phone's IMU. HTTPS with a self-signed cert is —
 * you just have to click through the browser warning once on the phone.
 */

const { createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isIP } = require('net');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CRT_PATH = path.join(CERT_DIR, 'cert.pem');

/** Every non-internal IPv4 address, so the cert covers whichever LAN IP is live. */
function localAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// Minimal DER encoding for an X.509 v3 certificate with a subjectAltName.
// Key generation and signing use Node's native crypto implementation.
function der(tag, content) {
  const size = content.length;
  let length;
  if (size < 128) length = Buffer.from([size]);
  else {
    const bytes = [];
    for (let n = size; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 255);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const sequence = (...parts) => der(0x30, Buffer.concat(parts));
const oid = (bytes) => der(0x06, Buffer.from(bytes));
const nullValue = der(0x05, Buffer.alloc(0));
const rsaSha256 = sequence(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), nullValue);
const sanOid = oid([0x55, 0x1d, 0x11]);
const cnOid = oid([0x55, 0x04, 0x03]);

function pem(label, bytes) {
  const lines = bytes.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function generateCertificate(ips = localAddresses()) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = sequence(der(0x31, sequence(cnOid, der(0x0c, Buffer.from('openwii.local')))));
  const now = new Date();
  const expires = new Date(now.getTime() + 825 * 24 * 60 * 60 * 1000);
  const time = (date) => der(0x18, Buffer.from(date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')));
  const names = [der(0x82, Buffer.from('localhost', 'ascii')),
    ...['127.0.0.1', ...ips].map((ip) => {
      if (isIP(ip) !== 4) throw new Error(`Invalid local IPv4 address: ${ip}`);
      return der(0x87, Buffer.from(ip.split('.').map(Number)));
    })];
  const extensions = der(0xa3, sequence(sequence(sanOid, der(0x04, sequence(...names)))));
  const serial = randomBytes(16);
  const positiveSerial = serial[0] & 0x80 ? Buffer.concat([Buffer.from([0]), serial]) : serial;
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, positiveSerial),
    rsaSha256,
    name,
    sequence(time(now), time(expires)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('RSA-SHA256', tbs, privateKey);
  const cert = pem('CERTIFICATE', sequence(tbs, rsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature]))));
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { key, cert };
}

/** Reuse a certificate only while it covers the current network and key. */
function existingCert(quiet) {
  if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CRT_PATH)) return null;
  try {
    const key = fs.readFileSync(KEY_PATH);
    const cert = fs.readFileSync(CRT_PATH);
    const x509 = new X509Certificate(cert);
    const keyPublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const certPublic = x509.publicKey.export({ type: 'spki', format: 'der' });
    const missing = localAddresses().filter((ip) => !x509.checkIP(ip));
    if (new Date(x509.validFrom) <= new Date() && new Date(x509.validTo) > new Date() && x509.checkHost('localhost') &&
        keyPublic.equals(certPublic) && missing.length === 0) return { key, cert };
    if (missing.length && !quiet) {
      console.log(`[cert] regenerating — cert predates current address ${missing.join(', ')}`);
    }
  } catch (err) {
    if (!quiet) console.log(`[cert] regenerating invalid certificate: ${err.message}`);
  }
  return null;
}

function ensureCert({ quiet = false } = {}) {
  // A cert pinned to an old DHCP lease still loads, but the phone then hits a
  // NAME_INVALID error that looks nothing like "self-signed" — so check the
  // SANs rather than just the file's existence.
  const existing = existingCert(quiet);
  if (existing) return existing;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const ips = localAddresses();
  const tls = generateCertificate(ips);
  fs.writeFileSync(KEY_PATH, tls.key, { mode: 0o600 });
  fs.writeFileSync(CRT_PATH, tls.cert, { mode: 0o600 });
  if (!quiet) console.log(`[cert] generated self-signed cert for localhost, 127.0.0.1${ips.length ? `, ${ips.join(', ')}` : ''}`);
  return tls;
}

module.exports = { ensureCert, generateCertificate, localAddresses, CERT_DIR };

if (require.main === module) ensureCert();
