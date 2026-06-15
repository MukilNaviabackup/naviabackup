'use strict';
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const helmetConfig = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
            styleSrc:    ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
            fontSrc:     ["'self'", "fonts.gstatic.com"],
            imgSrc:      ["'self'", "data:"],
            connectSrc:  ["'self'", "https://backup.navia.co.in"],
            frameSrc:    ["'none'"],
            objectSrc:   ["'none'"],
        }
    },
    hsts:           { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    noSniff:        true,
    frameguard:     { action: 'deny' },
    xssFilter:      true,
    hidePoweredBy:  true,
});

const corsConfig = {
    origin:         true,
    methods:        ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-sync-key'],
    credentials:    true,
    maxAge:         86400,
};

// ── Safe IP extractor — handles Azure proxy IP format ─────────────────────────
function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ip = forwarded.split(',')[0].trim();
        return ip;
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    // Strip port if present (e.g. "183.82.242.244:58948" → "183.82.242.244")
    return ip.replace(/:\d+$/, '').replace(/^::ffff:/, '');
}

const clientAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
    keyGenerator: (req) => getClientIP(req) + ':' + (req.body?.ucc || ''),
    validate: { xForwardedForHeader: false, trustProxy: false }
});

const adminAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skipSuccessfulRequests: true,
    message: { error: 'Too many admin login attempts. Account locked for 15 minutes.' },
    keyGenerator: (req) => getClientIP(req),
    validate: { xForwardedForHeader: false, trustProxy: false }
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    message: { error: 'Too many requests. Please slow down.' },
    keyGenerator: (req) => getClientIP(req),
    validate: { xForwardedForHeader: false, trustProxy: false }
});

const bmsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1000,
    message: { error: 'BMS rate limit exceeded.' },
    keyGenerator: (req) => getClientIP(req),
    validate: { xForwardedForHeader: false, trustProxy: false }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many file uploads. Please wait.' },
    keyGenerator: (req) => getClientIP(req),
    validate: { xForwardedForHeader: false, trustProxy: false }
});

const validateClientCreate = [
    body('ucc').trim().notEmpty().withMessage('UCC is required')
        .isAlphanumeric().withMessage('UCC must be alphanumeric')
        .isLength({ min: 1, max: 20 }).withMessage('UCC max 20 chars'),
    body('dob').notEmpty().withMessage('Date of birth is required')
        .isISO8601().withMessage('DOB must be valid date (YYYY-MM-DD)'),
    body('mobile').trim().notEmpty().withMessage('Mobile is required')
        .matches(/^[0-9]{10}$/).withMessage('Mobile must be 10 digits'),
    body('email').trim().notEmpty().withMessage('Email is required')
        .isEmail().withMessage('Invalid email format').normalizeEmail(),
    body('client_name').trim().notEmpty().withMessage('Client name is required')
        .isLength({ max: 200 }).withMessage('Name max 200 chars'),
    body('pan').optional().trim()
        .matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).withMessage('Invalid PAN format'),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                error: 'Validation failed',
                details: errors.array().map(e => ({ field: e.path, message: e.msg }))
            });
        }
        next();
    }
];

const validateLoginInitiate = [
    body('ucc').trim().notEmpty().withMessage('UCC is required')
        .isLength({ min: 1, max: 20 }).withMessage('Invalid UCC'),
    body('dob').notEmpty().withMessage('Date of birth is required'),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }
        next();
    }
];

const validateOTP = [
    body('otp').trim().notEmpty().withMessage('OTP is required')
        .matches(/^[0-9]{6}$/).withMessage('OTP must be 6 digits'),
    body('sessionId').trim().notEmpty().withMessage('Session ID is required'),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }
        next();
    }
];

const requestSizeLimits = { json: '100kb', urlencoded: '50kb' };

function suspiciousRequestFilter(req, res, next) {
    const suspicious = [
        /(\.\.|\/etc\/|\/proc\/)/i,
        /(<script|javascript:|vbscript:)/i,
        /(\%00|\%0a|\%0d)/i,
    ];
    const urlToCheck = req.path + JSON.stringify(req.query);
    for (const pattern of suspicious) {
        if (pattern.test(urlToCheck)) {
            console.warn(`[Security] Blocked: ${getClientIP(req)} → ${req.url}`);
            return res.status(400).json({ error: 'Invalid request.' });
        }
    }
    next();
}

function validateBMSApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required.' });
    if (apiKey !== process.env.BMS_API_KEY) {
        console.warn(`[Security] Invalid BMS key from ${getClientIP(req)}`);
        return res.status(401).json({ error: 'Invalid API key.' });
    }
    next();
}

function securityLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const dur = Date.now() - start;
        if (res.statusCode === 401 || res.statusCode === 403) {
            console.warn(`[Security] ${res.statusCode} | ${req.method} ${req.path} | IP: ${getClientIP(req)} | ${dur}ms`);
        }
        if (dur > 5000) {
            console.warn(`[Perf] Slow: ${req.method} ${req.path} | ${dur}ms`);
        }
    });
    next();
}

module.exports = {
    helmetConfig, corsConfig,
    clientAuthLimiter, adminAuthLimiter,
    generalLimiter, bmsLimiter, uploadLimiter,
    validateClientCreate, validateLoginInitiate, validateOTP,
    requestSizeLimits, suspiciousRequestFilter,
    validateBMSApiKey, securityLogger,
};
