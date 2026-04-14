const jwt = require('jsonwebtoken');

const auth = (roles = []) => (req, res, next) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
