// A software authenticator used by the end-to-end test.
//
// It behaves like a phone's platform authenticator: it holds an ECDSA P-256 private key,
// builds real authenticator data and signs the assertion exactly as Chrome's virtual
// authenticator (and a real fingerprint sensor) would. Nothing is faked on the server side,
// so a passing test means the server really verified a signature.
const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();

// ---------- minimal CBOR encoder (only what attestation objects need) ----------
function head(major, length) {
  const m = major << 5;
  if (length < 24) return Buffer.from([m | length]);
  if (length < 256) return Buffer.from([m | 24, length]);
  if (length < 65536) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

function cbor(value) {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const utf8 = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, utf8.length), utf8]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("Unsupported CBOR value");
}

class VirtualAuthenticator {
  constructor({ rpId, origin }) {
    this.rpId = rpId;
    this.origin = origin;
    this.credentialId = crypto.randomBytes(32);
    this.counter = 0;
    this.keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  }

  #clientData(type, challenge) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  #authData(flags, { attested = null, counter = 0 } = {}) {
    const parts = [sha256(Buffer.from(this.rpId)), Buffer.from([flags])];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    parts.push(count);
    if (attested) parts.push(attested);
    return Buffer.concat(parts);
  }

  #coseKey() {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return cbor(
      new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
  }

  // Answer a registration challenge the way a platform authenticator does.
  register(options) {
    const clientDataJSON = this.#clientData("webauthn.create", options.challenge);
    const cose = this.#coseKey();
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);

    const attested = Buffer.concat([
      Buffer.alloc(16), // AAGUID: all zero for a platform authenticator
      idLen,
      this.credentialId,
      cose,
    ]);

    // UP (0x01) | UV (0x04) + AT (0x40): user verified, attested credential included.
    const authData = this.#authData(0x45, { attested });
    const attestationObject = cbor(
      new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  // Sign a fresh challenge. This is the step that proves the user was present.
  assert(options) {
    this.counter += 1;
    const clientDataJSON = this.#clientData("webauthn.get", options.challenge);
    // UP | UV, no attested data.
    const authData = this.#authData(0x05, { counter: this.counter });
    const signature = crypto.sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.keys.privateKey,
    );

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: null,
      },
    };
  }
}

module.exports = { VirtualAuthenticator };
