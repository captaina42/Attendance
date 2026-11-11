// Server-side photo validation for attendance submissions.
//
// Nothing here trusts the client: the image is decoded on the server with jimp, re-measured
// and re-hashed. Client-reported face counts are stored only as a hint and are never the
// sole reason a submission is rejected; a poor-quality image is flagged for review.
const { Jimp } = require("jimp");
const crypto = require("crypto");

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 500;
const MIN_DIM = 120;
const ANALYSIS_SIZE = 128;
const HASH_SIZE = 16; // 16x16 dHash -> 256 bits

const SCREEN_LIKE = new Set([
  "1080x1920", "1080x2340", "1080x2400", "1440x3200", "1170x2532", "1284x2778",
  "1125x2436", "750x1334", "828x1792", "1242x2688", "1080x2160", "720x1280",
  "1920x1080", "2560x1440", "1366x768", "1280x720", "2532x1170", "2778x1284",
]);

function detectMime(buffer) {
  if (buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return "image/png";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50)
    return "image/webp";
  return "";
}

function toGray(image, size) {
  const small = image.clone().resize({ w: size, h: size });
  const gray = new Float32Array(size * size);
  let i = 0;
  small.scan(0, 0, size, size, (x, y, idx) => {
    const r = small.bitmap.data[idx];
    const g = small.bitmap.data[idx + 1];
    const b = small.bitmap.data[idx + 2];
    gray[y * size + x] = 0.299 * r + 0.587 * g + 0.114 * b;
  });
  return { gray, size };
}

function meanLuminance(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return sum / gray.length;
}

// Variance of the Laplacian response: a cheap, robust blur metric.
function laplacianVariance(gray, size) {
  // Build Laplacian (4-neighbour) response.
  const out = new Float32Array(size * size);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const c = gray[y * size + x];
      const v = 4 * c - gray[(y - 1) * size + x] - gray[(y + 1) * size + x] -
        gray[y * size + (x - 1)] - gray[y * size + (x + 1)];
      out[y * size + x] = v;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// Difference hash (dHash): robust to small changes, good for perceptual comparison.
function dHash(image, size) {
  const small = image.clone().resize({ w: size + 1, h: size });
  // grayscale
  const gray = new Float32Array((size + 1) * size);
  small.scan(0, 0, size + 1, size, (x, y, idx) => {
    const r = small.bitmap.data[idx];
    const g = small.bitmap.data[idx + 1];
    const b = small.bitmap.data[idx + 2];
    gray[y * (size + 1) + x] = 0.299 * r + 0.587 * g + 0.114 * b;
  });
  let bits = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bits += gray[y * (size + 1) + x] > gray[y * (size + 1) + (x + 1)] ? "1" : "0";
    }
  }
  // pack into hex
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // popcount of 4-bit
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

async function validatePhoto(buffer, opts = {}) {
  const result = {
    ok: true,
    reasons: [],
    severity: "low",
    phash: "",
    width: 0,
    height: 0,
    mime: "",
    brightness: 0,
    blur: 0,
    faceCountReported: opts.faceCount == null ? null : Number(opts.faceCount),
    faceDetectionAvailable: opts.faceCount != null,
  };

  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES) {
    result.ok = false;
    result.reasons.push("Image is too small or empty.");
    result.severity = "medium";
    return result;
  }
  if (buffer.length > MAX_BYTES) {
    result.ok = false;
    result.reasons.push("Image exceeds the size limit.");
    result.severity = "medium";
    return result;
  }

  const mime = detectMime(buffer);
  if (!mime) {
    result.ok = false;
    result.reasons.push("Unsupported or unrecognised image format.");
    result.severity = "medium";
    return result;
  }
  result.mime = mime;

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (e) {
    result.ok = false;
    result.reasons.push("Image file is corrupted or could not be decoded.");
    result.severity = "medium";
    return result;
  }

  const { width, height } = image.bitmap;
  result.width = width;
  result.height = height;
  if (width < MIN_DIM || height < MIN_DIM) {
    result.ok = false;
    result.reasons.push("Image resolution is too low.");
    result.severity = "medium";
  }

  // Brightness + blur on a normalised thumbnail.
  const { gray, size } = toGray(image, ANALYSIS_SIZE);
  const brightness = meanLuminance(gray);
  result.brightness = Math.round(brightness);
  if (brightness < 35) {
    result.reasons.push("Image is too dark to verify.");
    result.severity = bump(result.severity, "medium");
  } else if (brightness > 235) {
    result.reasons.push("Image is overexposed.");
    result.severity = bump(result.severity, "low");
  }

  const blur = laplacianVariance(gray, size);
  result.blur = Math.round(blur);
  if (blur < 40) {
    result.reasons.push("Image appears blurry or out of focus.");
    result.severity = bump(result.severity, "medium");
  }

  // Perceptual hash for similarity / reuse detection.
  try {
    result.phash = dHash(image, HASH_SIZE);
  } catch (e) {
    result.phash = "";
  }

  // Screenshot heuristic: PNG with screen-like dimensions and very high sharpness.
  const key = `${width}x${height}`;
  if (mime === "image/png" && SCREEN_LIKE.has(key) && blur > 200) {
    result.reasons.push("Possible screenshot (screen-sized PNG with high sharpness).");
    result.severity = bump(result.severity, "low");
  }

  // Face-count hint from the browser (best effort, client-reported).
  const fc = result.faceCountReported;
  if (fc === 0) {
    result.reasons.push("No face detected in the capture (client check).");
    result.severity = bump(result.severity, "high");
  } else if (fc != null && fc > 1) {
    result.reasons.push(`Multiple faces detected in the capture (${fc}).`);
    result.severity = bump(result.severity, "high");
  } else if (fc == null) {
    // Face detection not available on this device/browser: record as informational only,
    // do not flag, because this is not evidence of a problem.
    result.faceDetectionAvailable = false;
  }

  if (result.reasons.length) result.ok = false;
  return result;
}

function bump(current, next) {
  const order = { low: 0, medium: 1, high: 2 };
  return order[next] > order[current] ? next : current;
}

module.exports = { validatePhoto, detectMime, dHash, hamming, MAX_BYTES, MIN_BYTES };
module.exports.hamming = hamming;
module.exports.MIN_DIM = MIN_DIM;
