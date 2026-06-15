const express = require('express');
const router = express.Router();
const { getConnection, sql } = require('../config/database');
require('dotenv').config();

// API Key middleware for SharePro authentication
function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!apiKey || apiKey !== process.env.SHAREPRO_API_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized. Invalid API key.',
            code: 'INVALID_API_KEY'
        });
    }
    next();
}

// ─── POST /api/sync/client ─────────────────────────────────────────────────
// AddUpdateClient — Upsert (Create if new, Update if exists)
router.post('/client', validateApiKey, async (req, res) => {
    const {
        // Required fields
        ucc,
        client_name,
        dob,
        mobile,
        email,

        // Identity
        pan,
        dp_id,
        bo_id,

        // Account status
        // ACTIVE | INACTIVE | SUSPENDED | CLOSED | ACCOUNT_CLOSED
        account_status,

        // Segment flags
        nse_cm,
        nse_fo,
        nse_cd,
        bse_cm,
        bse_fo,
        bse_cd,
        mcx_fo,

        // Address
        address,
        pincode,
        city,
        state,

        // Meta
        modified_by
    } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    const errors = [];
    if (!ucc)         errors.push('ucc is required');
    if (!client_name) errors.push('client_name is required');
    if (!dob)         errors.push('dob is required (YYYY-MM-DD)');
    if (!mobile)      errors.push('mobile is required');
    if (!email)       errors.push('email is required');

    if (mobile && !/^\d{10,13}$/.test(mobile.toString().replace(/\D/g, ''))) {
        errors.push('mobile must be 10-13 digits');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('email format is invalid');
    }
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan.toUpperCase())) {
        errors.push('pan format is invalid (e.g. ABCDE1234F)');
    }

    const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED', 'ACCOUNT_CLOSED'];
    if (account_status && !validStatuses.includes(account_status.toUpperCase())) {
        errors.push(`account_status must be one of: ${validStatuses.join(', ')}`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, errors, code: 'VALIDATION_ERROR' });
    }

    try {
        const pool = await getConnection();

        // Check if UCC already exists
        const existing = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.toString().trim())
            .query('SELECT client_id, ucc, email, mobile FROM clients WHERE ucc = @ucc');

        const isUpdate = existing.recordset.length > 0;
        const isActive = !account_status || account_status.toUpperCase() === 'ACTIVE' ? 1 : 0;
        const cleanMobile = mobile.toString().replace(/\D/g, '');
        const statusUpper = (account_status || 'ACTIVE').toUpperCase();

        if (isUpdate) {
            // ── UPDATE existing client ──────────────────────────────────────
            await pool.request()
                .input('ucc',           sql.VarChar(20),  ucc.toString().trim())
                .input('clientName',    sql.VarChar(200), client_name.trim())
                .input('dob',           sql.Date,         new Date(dob))
                .input('mobile',        sql.VarChar(15),  cleanMobile)
                .input('email',         sql.VarChar(100), email.trim().toLowerCase())
                .input('pan',           sql.VarChar(10),  pan ? pan.toUpperCase().trim() : null)
                .input('dpId',          sql.VarChar(20),  dp_id || null)
                .input('boId',          sql.VarChar(20),  bo_id || null)
                .input('accountStatus', sql.VarChar(20),  statusUpper)
                .input('isActive',      sql.Bit,          isActive)
                .input('nseCm',         sql.Bit,          nse_cm != null ? (nse_cm ? 1 : 0) : null)
                .input('nseFo',         sql.Bit,          nse_fo != null ? (nse_fo ? 1 : 0) : null)
                .input('nseCd',         sql.Bit,          nse_cd != null ? (nse_cd ? 1 : 0) : null)
                .input('bseCm',         sql.Bit,          bse_cm != null ? (bse_cm ? 1 : 0) : null)
                .input('bseFo',         sql.Bit,          bse_fo != null ? (bse_fo ? 1 : 0) : null)
                .input('bseCd',         sql.Bit,          bse_cd != null ? (bse_cd ? 1 : 0) : null)
                .input('mcxFo',         sql.Bit,          mcx_fo != null ? (mcx_fo ? 1 : 0) : null)
                .input('address',       sql.VarChar(500), address || null)
                .input('pincode',       sql.VarChar(10),  pincode || null)
                .input('city',          sql.VarChar(100), city || null)
                .input('state',         sql.VarChar(100), state || null)
                .input('modifiedBy',    sql.VarChar(50),  modified_by || 'SHAREPRO_SYNC')
                .query(`UPDATE clients SET
                    client_name      = @clientName,
                    dob              = @dob,
                    mobile           = @mobile,
                    email            = @email,
                    pan              = COALESCE(@pan, pan),
                    dp_id            = COALESCE(@dpId, dp_id),
                    bo_id            = COALESCE(@boId, bo_id),
                    account_status   = @accountStatus,
                    is_active        = @isActive,
                    nse_cm           = COALESCE(@nseCm, nse_cm),
                    nse_fo           = COALESCE(@nseFo, nse_fo),
                    nse_cd           = COALESCE(@nseCd, nse_cd),
                    bse_cm           = COALESCE(@bseCm, bse_cm),
                    bse_fo           = COALESCE(@bseFo, bse_fo),
                    bse_cd           = COALESCE(@bseCd, bse_cd),
                    mcx_fo           = COALESCE(@mcxFo, mcx_fo),
                    address          = COALESCE(@address, address),
                    pincode          = COALESCE(@pincode, pincode),
                    city             = COALESCE(@city, city),
                    state            = COALESCE(@state, state),
                    last_synced_at   = GETDATE(),
                    modified_at      = GETDATE(),
                    modified_by      = @modifiedBy
                WHERE ucc = @ucc`);

            return res.json({
                success: true,
                action: 'UPDATED',
                ucc: ucc.toString().trim(),
                message: `Client ${ucc} updated successfully.`,
                timestamp: new Date().toISOString()
            });

        } else {
            // ── INSERT new client ───────────────────────────────────────────
            await pool.request()
                .input('ucc',           sql.VarChar(20),  ucc.toString().trim())
                .input('clientName',    sql.VarChar(200), client_name.trim())
                .input('dob',           sql.Date,         new Date(dob))
                .input('mobile',        sql.VarChar(15),  cleanMobile)
                .input('email',         sql.VarChar(100), email.trim().toLowerCase())
                .input('pan',           sql.VarChar(10),  pan ? pan.toUpperCase().trim() : null)
                .input('dpId',          sql.VarChar(20),  dp_id || null)
                .input('boId',          sql.VarChar(20),  bo_id || null)
                .input('accountStatus', sql.VarChar(20),  statusUpper)
                .input('isActive',      sql.Bit,          isActive)
                .input('nseCm',         sql.Bit,          nse_cm ? 1 : 0)
                .input('nseFo',         sql.Bit,          nse_fo ? 1 : 0)
                .input('nseCd',         sql.Bit,          nse_cd ? 1 : 0)
                .input('bseCm',         sql.Bit,          bse_cm ? 1 : 0)
                .input('bseFo',         sql.Bit,          bse_fo ? 1 : 0)
                .input('bseCd',         sql.Bit,          bse_cd ? 1 : 0)
                .input('mcxFo',         sql.Bit,          mcx_fo ? 1 : 0)
                .input('address',       sql.VarChar(500), address || null)
                .input('pincode',       sql.VarChar(10),  pincode || null)
                .input('city',          sql.VarChar(100), city || null)
                .input('state',         sql.VarChar(100), state || null)
                .input('modifiedBy',    sql.VarChar(50),  modified_by || 'SHAREPRO_SYNC')
                .query(`INSERT INTO clients (
                    ucc, client_name, dob, mobile, email,
                    pan, dp_id, bo_id, account_status, is_active,
                    nse_cm, nse_fo, nse_cd, bse_cm, bse_fo, bse_cd, mcx_fo,
                    address, pincode, city, state,
                    last_synced_at, modified_by
                ) VALUES (
                    @ucc, @clientName, @dob, @mobile, @email,
                    @pan, @dpId, @boId, @accountStatus, @isActive,
                    @nseCm, @nseFo, @nseCd, @bseCm, @bseFo, @bseCd, @mcxFo,
                    @address, @pincode, @city, @state,
                    GETDATE(), @modifiedBy
                )`);

            return res.json({
                success: true,
                action: 'CREATED',
                ucc: ucc.toString().trim(),
                message: `Client ${ucc} created successfully.`,
                timestamp: new Date().toISOString()
            });
        }

    } catch (err) {
        console.error('AddUpdateClient error:', err);
        return res.status(500).json({
            success: false,
            error: 'Internal server error.',
            code: 'SERVER_ERROR'
        });
    }
});

// ─── POST /api/sync/clients/bulk ──────────────────────────────────────────
// Bulk upsert — for daily SharePro sync (array of clients)
router.post('/clients/bulk', validateApiKey, async (req, res) => {
    const { clients } = req.body;

    if (!clients || !Array.isArray(clients) || clients.length === 0) {
        return res.status(400).json({ success: false, error: 'clients array is required.' });
    }

    if (clients.length > 5000) {
        return res.status(400).json({ success: false, error: 'Max 5000 clients per batch.' });
    }

    const results = { created: 0, updated: 0, failed: 0, errors: [] };

    try {
        const pool = await getConnection();

        for (const client of clients) {
            try {
                const { ucc, client_name, dob, mobile, email } = client;
                if (!ucc || !client_name || !dob || !mobile || !email) {
                    results.failed++;
                    results.errors.push({ ucc: ucc || 'UNKNOWN', error: 'Missing required fields' });
                    continue;
                }

                const existing = await pool.request()
                    .input('ucc', sql.VarChar(20), ucc.toString().trim())
                    .query('SELECT client_id FROM clients WHERE ucc = @ucc');

                const isActive = !client.account_status || client.account_status.toUpperCase() === 'ACTIVE' ? 1 : 0;
                const cleanMobile = mobile.toString().replace(/\D/g, '');
                const statusUpper = (client.account_status || 'ACTIVE').toUpperCase();

                if (existing.recordset.length > 0) {
                    await pool.request()
                        .input('ucc',           sql.VarChar(20),  ucc.toString().trim())
                        .input('clientName',    sql.VarChar(200), client_name.trim())
                        .input('dob',           sql.Date,         new Date(dob))
                        .input('mobile',        sql.VarChar(15),  cleanMobile)
                        .input('email',         sql.VarChar(100), email.trim().toLowerCase())
                        .input('pan',           sql.VarChar(10),  client.pan ? client.pan.toUpperCase() : null)
                        .input('dpId',          sql.VarChar(20),  client.dp_id || null)
                        .input('boId',          sql.VarChar(20),  client.bo_id || null)
                        .input('accountStatus', sql.VarChar(20),  statusUpper)
                        .input('isActive',      sql.Bit,          isActive)
                        .input('nseCm',         sql.Bit,          client.nse_cm ? 1 : 0)
                        .input('nseFo',         sql.Bit,          client.nse_fo ? 1 : 0)
                        .input('nseCd',         sql.Bit,          client.nse_cd ? 1 : 0)
                        .input('bseCm',         sql.Bit,          client.bse_cm ? 1 : 0)
                        .input('bseFo',         sql.Bit,          client.bse_fo ? 1 : 0)
                        .input('bseCd',         sql.Bit,          client.bse_cd ? 1 : 0)
                        .input('mcxFo',         sql.Bit,          client.mcx_fo ? 1 : 0)
                        .query(`UPDATE clients SET
                            client_name = @clientName, dob = @dob,
                            mobile = @mobile, email = @email,
                            pan = COALESCE(@pan, pan),
                            dp_id = COALESCE(@dpId, dp_id),
                            bo_id = COALESCE(@boId, bo_id),
                            account_status = @accountStatus,
                            is_active = @isActive,
                            nse_cm = @nseCm, nse_fo = @nseFo, nse_cd = @nseCd,
                            bse_cm = @bseCm, bse_fo = @bseFo, bse_cd = @bseCd,
                            mcx_fo = @mcxFo,
                            last_synced_at = GETDATE(), modified_at = GETDATE(),
                            modified_by = 'SHAREPRO_BULK'
                        WHERE ucc = @ucc`);
                    results.updated++;
                } else {
                    await pool.request()
                        .input('ucc',           sql.VarChar(20),  ucc.toString().trim())
                        .input('clientName',    sql.VarChar(200), client_name.trim())
                        .input('dob',           sql.Date,         new Date(dob))
                        .input('mobile',        sql.VarChar(15),  cleanMobile)
                        .input('email',         sql.VarChar(100), email.trim().toLowerCase())
                        .input('pan',           sql.VarChar(10),  client.pan ? client.pan.toUpperCase() : null)
                        .input('dpId',          sql.VarChar(20),  client.dp_id || null)
                        .input('boId',          sql.VarChar(20),  client.bo_id || null)
                        .input('accountStatus', sql.VarChar(20),  statusUpper)
                        .input('isActive',      sql.Bit,          isActive)
                        .input('nseCm',         sql.Bit,          client.nse_cm ? 1 : 0)
                        .input('nseFo',         sql.Bit,          client.nse_fo ? 1 : 0)
                        .input('nseCd',         sql.Bit,          client.nse_cd ? 1 : 0)
                        .input('bseCm',         sql.Bit,          client.bse_cm ? 1 : 0)
                        .input('bseFo',         sql.Bit,          client.bse_fo ? 1 : 0)
                        .input('bseCd',         sql.Bit,          client.bse_cd ? 1 : 0)
                        .input('mcxFo',         sql.Bit,          client.mcx_fo ? 1 : 0)
                        .query(`INSERT INTO clients (
                            ucc, client_name, dob, mobile, email,
                            pan, dp_id, bo_id, account_status, is_active,
                            nse_cm, nse_fo, nse_cd, bse_cm, bse_fo, bse_cd, mcx_fo,
                            last_synced_at, modified_by
                        ) VALUES (
                            @ucc, @clientName, @dob, @mobile, @email,
                            @pan, @dpId, @boId, @accountStatus, @isActive,
                            @nseCm, @nseFo, @nseCd, @bseCm, @bseFo, @bseCd, @mcxFo,
                            GETDATE(), 'SHAREPRO_BULK'
                        )`);
                    results.created++;
                }
            } catch (clientErr) {
                results.failed++;
                results.errors.push({ ucc: client.ucc || 'UNKNOWN', error: clientErr.message });
            }
        }

        return res.json({
            success: true,
            action: 'BULK_SYNC',
            results,
            total_received: clients.length,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('Bulk sync error:', err);
        return res.status(500).json({ success: false, error: 'Bulk sync failed.', code: 'SERVER_ERROR' });
    }
});

// ─── GET /api/sync/client/:ucc ────────────────────────────────────────────
// GetClientDetails — fetch full client profile
router.get('/client/:ucc', validateApiKey, async (req, res) => {
    const { ucc } = req.params;
    if (!ucc) return res.status(400).json({ success: false, error: 'UCC is required.' });

    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.toString().trim())
            .query(`SELECT
                client_id, ucc, client_name, dob, mobile, email,
                pan, dp_id, bo_id, account_status, is_active,
                nse_cm, nse_fo, nse_cd,
                bse_cm, bse_fo, bse_cd,
                mcx_fo,
                address, pincode, city, state,
                last_synced_at, modified_at, modified_by, created_at
            FROM clients WHERE ucc = @ucc`);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Client with UCC ${ucc} not found.`,
                code: 'CLIENT_NOT_FOUND'
            });
        }

        const client = result.recordset[0];

        return res.json({
            success: true,
            client: {
                // Identity
                client_id:      client.client_id,
                ucc:            client.ucc,
                client_name:    client.client_name,
                dob:            client.dob,
                pan:            client.pan,
                dp_id:          client.dp_id,
                bo_id:          client.bo_id,

                // Contact
                mobile:         client.mobile,
                email:          client.email,

                // Location
                address:        client.address,
                pincode:        client.pincode,
                city:           client.city,
                state:          client.state,

                // Account Status
                account_status: client.account_status,
                is_active:      client.is_active,

                // Segments
                segments: {
                    nse_cm: client.nse_cm,
                    nse_fo: client.nse_fo,
                    nse_cd: client.nse_cd,
                    bse_cm: client.bse_cm,
                    bse_fo: client.bse_fo,
                    bse_cd: client.bse_cd,
                    mcx_fo: client.mcx_fo,
                },

                // Meta
                last_synced_at: client.last_synced_at,
                modified_at:    client.modified_at,
                modified_by:    client.modified_by,
                created_at:     client.created_at
            },
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('GetClientDetails error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch client.', code: 'SERVER_ERROR' });
    }
});

// ─── GET /api/sync/health ─────────────────────────────────────────────────
// Health check for SharePro to verify connectivity
router.get('/health', validateApiKey, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .query('SELECT COUNT(*) as total_clients FROM clients');
        return res.json({
            success: true,
            status: 'Navia Backup Sync API is healthy',
            total_clients: result.recordset[0].total_clients,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'DB connection failed.' });
    }
});

module.exports = router;