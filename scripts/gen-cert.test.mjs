import assert from 'node:assert/strict';
import { createPublicKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { generateCertificate } = require('./gen-cert.js');

test('generates a valid LAN certificate that serves HTTPS', async () => {
  const tls = generateCertificate(['192.168.1.42']);
  const cert = new X509Certificate(tls.cert);
  assert.equal(cert.checkHost('localhost'), 'localhost');
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(cert.checkIP('192.168.1.42'), '192.168.1.42');
  assert.ok(new Date(cert.validFrom) <= new Date());
  assert.ok(new Date(cert.validTo) > new Date());
  assert.ok(cert.verify(cert.publicKey));
  assert.deepEqual(createPublicKey(tls.key).export({ type: 'spki', format: 'der' }),
    cert.publicKey.export({ type: 'spki', format: 'der' }));

  const server = https.createServer(tls, (_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      https.get({ hostname: '127.0.0.1', port: server.address().port, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.deepEqual(response, { status: 200, body: 'ok' });
  } finally {
    server.close();
  }
});
