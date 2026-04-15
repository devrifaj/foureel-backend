const jwt = require('jsonwebtoken');

function hasPayloadShape(decoded) {
  return (
    decoded &&
    typeof decoded === "object" &&
    Boolean(decoded.id) &&
    typeof decoded.role === "string" &&
    Object.prototype.hasOwnProperty.call(decoded, "clientId")
  );
}

const auth = (roles = []) => (req, res, next) => {
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
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = auth;
