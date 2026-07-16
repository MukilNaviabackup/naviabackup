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

// Dealer Admin (support-desk role, 14-Jul-2026): this role must never be able
// to generate or download the RMS square-off basket file, even by calling the
// API directly instead of going through the (also-hidden) UI button. Applied
// to POST /orders/generate-file and POST /orders/mark-file-generated in
// adminOrders.js. Deliberately does NOT block ADMIN or SUBUSER -- both keep
// their existing, unchanged file-generation access.
function blockDealerAdmin(req, res, next) {
    if (req.admin.role === 'DEALER_ADMIN') {
        return res.status(403).json({ error: 'File generation and download is not available for this role.' });
    }
    next();
}

module.exports = { adminAuthenticate, requireFullAdmin, blockDealerAdmin };