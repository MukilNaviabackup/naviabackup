const jwt = require('jsonwebtoken');
require('dotenv').config();

function adminAuthenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.adminId) {
            return res.status(401).json({ error: 'Invalid admin token.' });
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
    }
}

function requireFullAdmin(req, res, next) {
    if (req.admin.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Full admin access required.' });
    }
    next();
}

module.exports = { adminAuthenticate, requireFullAdmin };