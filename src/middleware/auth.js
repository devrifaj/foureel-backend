const jwt = require('jsonwebtoken');

function hasPayloadShape(decoded) {
  return (
    decoded &&
    typeof decoded === "object" &&
    Boolean(decoded.id) &&
    typeof decoded.role === "string" &&
    Object.prototype.hasOwnProperty.call(decoded, "clientId") &&
    Object.prototype.hasOwnProperty.call(decoded, "teamAccessLevel")
  );
}

function normalizeAuthOptions(input) {
  if (Array.isArray(input)) {
    const teamAccessLevels = input.includes("team") ? ["admin"] : [];
    return { roles: input, teamAccessLevels };
  }
  if (!input || typeof input !== "object") return { roles: [], teamAccessLevels: [] };
  const normalized = {
    roles: Array.isArray(input.roles) ? input.roles : [],
    teamAccessLevels: Array.isArray(input.teamAccessLevels)
      ? input.teamAccessLevels
      : [],
  };
  if (normalized.roles.includes("team") && normalized.teamAccessLevels.length === 0) {
    normalized.teamAccessLevels = ["admin"];
  }
  return normalized;
}

const auth = (options = []) => (req, res, next) => {
  const { roles, teamAccessLevels } = normalizeAuthOptions(options);
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!hasPayloadShape(decoded)) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    req.user = decoded;
    if (roles.length && !roles.includes(decoded.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (
      decoded.role === "team" &&
      teamAccessLevels.length &&
      !teamAccessLevels.includes(decoded.teamAccessLevel)
    ) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = auth;
