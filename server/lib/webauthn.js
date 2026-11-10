// Real WebAuthn (passkey) verification.
//
// The browser's signature is checked here against the public key stored at registration,
// so a fingerprint/face check cannot be spoofed by a page that merely reports success.
// Private keys never leave the phone; this server only ever holds a public key.
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { RP_ID, RP_NAME, APP_ORIGIN } = require("../config");
const { db } = require("../db");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// The Relying Party is the site the passkey is bound to: hostname only, no scheme or port.
function relyingParty(req) {
  const host = String(req.get("host") || "localhost").split(":")[0];
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const origin = APP_ORIGIN || `${proto}://${req.get("host")}`;
  return { rpID: RP_ID || host, origin };
}

function saveChallenge(studentId, challenge, kind) {
  db.prepare(
    `INSERT INTO webauthn_challenges (student_id, challenge, kind, expires_at)
     VALUES (?,?,?,?)
     ON CONFLICT(student_id) DO UPDATE SET
       challenge = excluded.challenge, kind = excluded.kind, expires_at = excluded.expires_at`,
  ).run(studentId, challenge, kind, Date.now() + CHALLENGE_TTL_MS);
}

// A challenge is single use: it is deleted whether or not the ceremony succeeds.
function takeChallenge(studentId, kind) {
  const row = db.prepare("SELECT * FROM webauthn_challenges WHERE student_id = ?").get(studentId);
  if (!row) return null;
  db.prepare("DELETE FROM webauthn_challenges WHERE student_id = ?").run(studentId);
  if (row.kind !== kind || row.expires_at < Date.now()) return null;
  return row.challenge;
}

function credentialFor(student) {
  if (!student || !student.credential_id || !student.credential_public_key) return null;
  return {
    id: student.credential_id,
    publicKey: new Uint8Array(Buffer.from(student.credential_public_key, "base64url")),
    counter: Number(student.credential_counter) || 0,
    transports: student.credential_transports
      ? student.credential_transports.split(",").filter(Boolean)
      : undefined,
  };
}

// Step 1a: options for enrolling a new passkey on this device.
async function registrationOptions(req, student) {
  const { rpID } = relyingParty(req);
  const existing = credentialFor(student);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(`student:${student.id}`),
    userName: student.student_number,
    userDisplayName: student.full_name,
    attestationType: "none",
    excludeCredentials: existing
      ? [{ id: existing.id, transports: existing.transports }]
      : [],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  saveChallenge(student.id, options.challenge, "registration");
  return options;
}

// Step 1b: options for proving it is really this student, right now.
async function authenticationOptions(req, student) {
  const { rpID } = relyingParty(req);
  const credential = credentialFor(student);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [{ id: credential.id, transports: credential.transports }],
    userVerification: "required",
  });
  saveChallenge(student.id, options.challenge, "authentication");
  return options;
}

// Step 2a: verify the new credential and store its public key.
async function verifyRegistration(req, student, response) {
  const { rpID, origin } = relyingParty(req);
  const expectedChallenge = takeChallenge(student.id, "registration");
  if (!expectedChallenge) throw new Error("The verification request expired. Please try again.");

  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserPresence: true,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo)
    throw new Error("This device could not be enrolled. Try again.");

  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  db.prepare(
    `UPDATE students SET
       credential_id = ?, credential_public_key = ?, credential_counter = ?,
       credential_transports = ?, credential_device_type = ?, credential_backed_up = ?,
       credential_created_at = ?
     WHERE id = ?`,
  ).run(
    credential.id,
    Buffer.from(credential.publicKey).toString("base64url"),
    credential.counter,
    (credential.transports || []).join(","),
    credentialDeviceType || "",
    credentialBackedUp ? 1 : 0,
    Date.now(),
    student.id,
  );
  return { credentialId: credential.id, counter: credential.counter };
}

// Step 2b: verify a fresh assertion. This is the biometric check that actually counts.
async function verifyAssertion(req, student, response) {
  const { rpID, origin } = relyingParty(req);
  const credential = credentialFor(student);
  if (!credential) throw new Error("No passkey is enrolled for your account on this server.");

  const expectedChallenge = takeChallenge(student.id, "authentication");
  if (!expectedChallenge) throw new Error("The verification request expired. Please try again.");

  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true,
  });
  if (!result.verified || !result.authenticationInfo)
    throw new Error("Biometric verification failed. Try again.");

  // A counter that goes backwards is the signature of a cloned authenticator.
  const newCounter = result.authenticationInfo.newCounter;
  if (newCounter > 0 && newCounter <= credential.counter && credential.counter !== 0)
    throw new Error("This passkey looks cloned. Re-enrol it from your own device.");

  db.prepare("UPDATE students SET credential_counter = ? WHERE id = ?").run(newCounter, student.id);
  return { userVerified: result.authenticationInfo.userVerified, newCounter };
}

function forgetCredential(studentId) {
  db.prepare(
    `UPDATE students SET credential_id = '', credential_public_key = '', credential_counter = 0,
       credential_transports = '', credential_device_type = '', credential_backed_up = 0,
       credential_created_at = 0
     WHERE id = ?`,
  ).run(studentId);
  db.prepare("DELETE FROM webauthn_challenges WHERE student_id = ?").run(studentId);
}

module.exports = {
  relyingParty,
  registrationOptions,
  authenticationOptions,
  verifyRegistration,
  verifyAssertion,
  forgetCredential,
  credentialFor,
};
