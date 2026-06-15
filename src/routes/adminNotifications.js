'use strict';
const express = require('express');
const router  = express.Router();
const { adminAuthenticate }                        = require('../middleware/adminAuthenticate');
const { getPendingAlerts, markAlertsSeen, getQueueLength } = require('../services/notificationService');

/* ── GET /api/admin/notifications/pending ───────────────────────────────────
 * Admin dashboard polls this every 3 seconds.
 * Returns new sq-off orders since the last poll timestamp.
 * Fast, reliable — works on Azure Windows App Service without any IIS config.
 * ─────────────────────────────────────────────────────────────────────────*/
router.get('/pending', adminAuthenticate, (req, res) => {
    const since  = req.query.since || null;
    const alerts = getPendingAlerts(since);
    return res.json({
        success: true,
        alerts,
        count:   alerts.length,
        queue:   getQueueLength(),
    });
});

/* ── POST /api/admin/notifications/seen ─────────────────────────────────────
 * Admin marks alerts as seen — removes them from the queue.
 * Called when admin dismisses the alert banner or clicks "Process Order".
 * ─────────────────────────────────────────────────────────────────────────*/
router.post('/seen', adminAuthenticate, (req, res) => {
    const { order_ids } = req.body;
    markAlertsSeen(order_ids || []);
    return res.json({ success: true });
});

module.exports = router;