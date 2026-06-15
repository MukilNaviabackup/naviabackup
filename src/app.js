'use strict';
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
require('dotenv').config();

const {
    helmetConfig, corsConfig,
    clientAuthLimiter, adminAuthLimiter,
    generalLimiter, bmsLimiter, uploadLimiter,
    requestSizeLimits, suspiciousRequestFilter,
    securityLogger
} = require('./middleware/securityMiddleware');

const authRoutes         = require('./routes/auth');
const positionRoutes     = require('./routes/positions');
const orderRoutes        = require('./routes/orders');
const adminAuthRoutes    = require('./routes/adminAuth');
const adminControlRoutes = require('./routes/adminControl');
const adminOrderRoutes   = require('./routes/adminOrders');
const adminNotifRoutes   = require('./routes/adminNotifications');
const dealerAuthRoutes   = require('./routes/dealerAuth');
const auditPublic        = require('./routes/auditPublic');
const syncClientRoutes   = require('./routes/syncClient');
const bfPositionsRoutes  = require('./routes/bfPositions');
const dropCopyRoutes     = require('./routes/dropCopySync');
const auditLogRoutes     = require('./routes/auditLog');
const clientRoutes       = require('./routes/clientRoutes');
const holdingsRoutes     = require('./routes/holdings');
const systemLogsRoutes   = require('./routes/systemLogs');
const sliceQtyRouter     = require('./routes/sliceQty');
const orderDownloadRouter = require('./routes/orderDownload');

const app = express();
app.set('trust proxy', 1);

app.use(helmetConfig);
app.use(cors(corsConfig));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(securityLogger);
app.use(suspiciousRequestFilter);

// Rate limiter — exclude dropcopy from general limiter
app.use('/api/', (req, res, next) => {
    // Exclude high-frequency and critical routes from general rate limiter
    if (req.path.startsWith('/dropcopy'))            return next(); // sync service
    if (req.path.startsWith('/admin/notifications')) return next(); // polling
    if (req.path.startsWith('/orders/squareoff'))    return next(); // CRITICAL — never rate limit sq-off
    return generalLimiter(req, res, next);
});

// ── Client routes ─────────────────────────────────────────────────────────────
app.use('/api/auth/login/initiate',   clientAuthLimiter);
app.use('/api/auth/login/verify-otp', clientAuthLimiter);
app.use('/api/auth',      authRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/orders',    orderRoutes);
app.use('/api/holdings',  holdingsRoutes);

// ── Admin routes ──────────────────────────────────────────────────────────────
app.use('/api/admin/auth/login/initiate',   adminAuthLimiter);
app.use('/api/admin/auth/login/verify-otp', adminAuthLimiter);
app.use('/api/admin/auth',           adminAuthRoutes);
app.use('/api/admin/control',        adminControlRoutes);
app.use('/api/admin/logs',           systemLogsRoutes);
app.use('/api/admin/clients',        bmsLimiter, clientRoutes);
app.use('/api/admin/slice-qty',      sliceQtyRouter);
app.use('/api/admin/orders',         orderDownloadRouter);
// Notifications route MUST be before the catch-all app.use('/api/admin')
// Express prefix matching would otherwise route /api/admin/notifications to adminOrderRoutes
app.use('/api/admin/notifications',  adminNotifRoutes);
app.use('/api/admin',                adminOrderRoutes);

// ── Dealer routes ─────────────────────────────────────────────────────────────
app.use('/api/dealer', dealerAuthRoutes);

// ── Public audit portal (HTTP Basic Auth, no admin login needed) ──────────────
app.use('/audit', auditPublic);

// ── Sync + BF + DropCopy routes ───────────────────────────────────────────────
app.use('/api/sync',     syncClientRoutes);
app.use('/api/bf',       uploadLimiter, bfPositionsRoutes);
app.use('/api/dropcopy', dropCopyRoutes);
app.use('/api/audit',    auditLogRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'Navia Backup API is running',
        time:   new Date().toISOString(),
        env:    process.env.NODE_ENV || 'production'
    });
});

// ── Serve React frontend ──────────────────────────────────────────────────────
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath, {
    maxAge: '1d',
    etag:   true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

app.get('*', (req, res) => {
    // Do NOT serve React for /audit/* — those are server-rendered HTML pages
    if (req.path.startsWith('/audit')) {
        return res.status(404).send('Not found');
    }
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[Error]', err.message, err.stack);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ── Start reconciliation service ─────────────────────────────────────────────
const { startReconciliationService } = require('./services/reconciliationService');

// ── Start server ──────────────────────────────────────────────────────────────
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`\nNavia Backup API  →  http://localhost:${PORT}`);
    console.log(`Environment       →  ${process.env.NODE_ENV || 'production'}`);
    console.log(`Health check      →  http://localhost:${PORT}/health\n`);
    // Start trade reconciliation engine
    startReconciliationService();
    server.timeout         = 300000; // 5 minutes
    server.keepAliveTimeout = 305000;
    server.headersTimeout  = 310000;
});

process.on('uncaughtException',  err    => console.error('[Fatal] Uncaught Exception:', err.message));
process.on('unhandledRejection', reason => console.error('[Fatal] Unhandled Rejection:', reason));
process.on('SIGTERM', () => {
    console.log('[Server] Graceful shutdown initiated...');
    server.close(() => console.log('[Server] Closed.'));
});