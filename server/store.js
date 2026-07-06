// In-memory store. For production replace with a database (Postgres, SQLite, etc.)
// so connections survive server restarts and tokens are encrypted at rest.
const connections = new Map();

module.exports = {
  saveConnection(conn) {
    connections.set(conn.id, conn);
  },
  getAll() {
    return Array.from(connections.values());
  },
  get(id) {
    return connections.get(id);
  },
  remove(id) {
    connections.delete(id);
  },
  count() {
    return connections.size;
  },
  updateTokens(id, { accessToken, refreshToken, expiresAt }) {
    const conn = connections.get(id);
    if (conn) {
      conn.accessToken  = accessToken;
      conn.refreshToken = refreshToken;
      conn.expiresAt    = expiresAt;
    }
  },
};
