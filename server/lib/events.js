// Minimal in-process Server-Sent Events bus for staff alerts.
// Keyed by staff id; one staff member may have several tabs open.
const clients = new Map(); // staffId -> Set of response objects

function register(staffId, res) {
  if (!clients.has(staffId)) clients.set(staffId, new Set());
  clients.get(staffId).add(res);
  res.on("close", () => {
    const set = clients.get(staffId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(staffId);
    }
  });
}

function broadcast(staffId, event, data) {
  const set = clients.get(staffId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

module.exports = { register, broadcast };
