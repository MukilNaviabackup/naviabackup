'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');
require('dotenv').config();

const TMP_DIR = path.join(os.tmpdir(), 'client_uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.csv')) cb(null, true);
        else cb(new Error('Only CSV files allowed'));
    }
});

function safeUnlink(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

// ─── CSV parser that handles quoted fields containing commas ─────────────────
function parseCSVLine(line) {
    const result = [];
    let current  = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf8')
        .replace(/^\uFEFF/, '')       // Remove BOM
        .replace(/\u00a0/g, ' ')      // Replace non-breaking spaces
        .replace(/\r\n/g, '\n')       // Normalize line endings
        .replace(/\r/g, '\n');

    const lines   = content.split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    const rows    = [];

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const vals = parseCSVLine(lines[i]);
        const row  = {};
        headers.forEach((h, idx) => {
            row[h] = (vals[idx] || '').trim().replace(/\u00a0/g, ' ');
        });
        rows.push(row);
    }
    return rows;
}

function toBit(val) {
    if (val === '1' || val === 'true' || val === 'yes') return 1;
    return 0;
}

// ─── Accepts DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY ──────────────────────────────
function toDate(val) {
    if (!val || val.trim() === '') return null;
    val = val.trim();

    // DD-MM-YYYY or DD/MM/YYYY
    if (/^\d{2}[-\/]\d{2}[-\/]\d{4}$/.test(val)) {
        const sep = val.includes('-') ? '-' : '/';
        const [d, m, y] = val.split(sep);
        const date = new Date(`${y}-${m}-${d}`);
        return isNaN(date) ? null : date;
    }

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const date = new Date(val);
        return isNaN(date) ? null : date;
    }

    return null;
}

// ─── POST /api/admin/clients/upload ──────────────────────────────────────────
router.post('/upload', adminAuthenticate, upload.single('client_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
        const rows = parseCSV(req.file.path);
        safeUnlink(req.file.path);

        if (!rows.length) return res.status(400).json({ error: 'File is empty.' });

        // Validate required columns
        const required = ['ucc', 'dob', 'mobile', 'email', 'client_name'];
        const missing  = required.filter(col => !(col in rows[0]));
        if (missing.length) {
            return res.status(400).json({ error: `Missing required columns: ${missing.join(', ')}` });
        }

        const pool = await getConnection();
        let inserted = 0, updated = 0, skipped = 0;
        const errors = [];

        for (const row of rows) {
            try {
                const ucc  = row['ucc']?.toUpperCase().trim().replace(/\u00a0/g, '');
                const dob  = toDate(row['dob']);
                const name = row['client_name']?.trim().replace(/\u00a0/g, '');

                if (!ucc || !dob || !name || !row['mobile']?.trim() || !row['email']?.trim()) {
                    errors.push(`Skipped: ${ucc || 'unknown'} — missing required field (dob: ${row['dob']}, name: ${name})`);
                    skipped++;
                    continue;
                }

                // Check if UCC already exists
                const existing = await pool.request()
                    .input('ucc', sql.VarChar(20), ucc)
                    .query('SELECT client_id FROM clients WHERE ucc = @ucc');

                if (existing.recordset.length > 0) {
                    await pool.request()
                        .input('ucc',        sql.VarChar(20),  ucc)
                        .input('dob',        sql.Date,         dob)
                        .input('mobile',     sql.VarChar(15),  row['mobile']?.trim())
                        .input('email',      sql.VarChar(100), row['email']?.trim().toLowerCase())
                        .input('clientName', sql.VarChar(200), name)
                        .input('pan',        sql.VarChar(10),  row['pan']?.trim() || null)
                        .input('dpId',       sql.VarChar(20),  row['dp_id']?.trim() || null)
                        .input('boId',       sql.VarChar(20),  row['bo_id']?.trim() || null)
                        .input('accStatus',  sql.VarChar(20),  row['account_status']?.trim() || 'ACTIVE')
                        .input('nseCm',      sql.Bit,          toBit(row['nse_cm']))
                        .input('nseFo',      sql.Bit,          toBit(row['nse_fo']))
                        .input('nseCd',      sql.Bit,          toBit(row['nse_cd']))
                        .input('bseCm',      sql.Bit,          toBit(row['bse_cm']))
                        .input('bseFo',      sql.Bit,          toBit(row['bse_fo']))
                        .input('bseCd',      sql.Bit,          toBit(row['bse_cd']))
                        .input('mcxFo',      sql.Bit,          toBit(row['mcx_fo']))
                        .input('address',    sql.VarChar(500), row['address']?.trim() || null)
                        .input('pincode',    sql.VarChar(10),  row['pincode']?.trim() || null)
                        .input('city',       sql.VarChar(100), row['city']?.trim() || null)
                        .input('state',      sql.VarChar(100), row['state']?.trim() || null)
                        .input('modifiedBy', sql.VarChar(50),  req.admin.username || 'admin')
                        .query(`
                            UPDATE clients SET
                                dob = @dob, mobile = @mobile, email = @email,
                                client_name = @clientName, pan = @pan,
                                dp_id = @dpId, bo_id = @boId,
                                account_status = @accStatus,
                                nse_cm = @nseCm, nse_fo = @nseFo, nse_cd = @nseCd,
                                bse_cm = @bseCm, bse_fo = @bseFo, bse_cd = @bseCd,
                                mcx_fo = @mcxFo,
                                address = @address, pincode = @pincode,
                                city = @city, state = @state,
                                modified_at = GETDATE(), modified_by = @modifiedBy
                            WHERE ucc = @ucc
                        `);
                    updated++;
                } else {
                    await pool.request()
                        .input('ucc',        sql.VarChar(20),  ucc)
                        .input('dob',        sql.Date,         dob)
                        .input('mobile',     sql.VarChar(15),  row['mobile']?.trim())
                        .input('email',      sql.VarChar(100), row['email']?.trim().toLowerCase())
                        .input('clientName', sql.VarChar(200), name)
                        .input('pan',        sql.VarChar(10),  row['pan']?.trim() || null)
                        .input('dpId',       sql.VarChar(20),  row['dp_id']?.trim() || null)
                        .input('boId',       sql.VarChar(20),  row['bo_id']?.trim() || null)
                        .input('accStatus',  sql.VarChar(20),  row['account_status']?.trim() || 'ACTIVE')
                        .input('nseCm',      sql.Bit,          toBit(row['nse_cm']))
                        .input('nseFo',      sql.Bit,          toBit(row['nse_fo']))
                        .input('nseCd',      sql.Bit,          toBit(row['nse_cd']))
                        .input('bseCm',      sql.Bit,          toBit(row['bse_cm']))
                        .input('bseFo',      sql.Bit,          toBit(row['bse_fo']))
                        .input('bseCd',      sql.Bit,          toBit(row['bse_cd']))
                        .input('mcxFo',      sql.Bit,          toBit(row['mcx_fo']))
                        .input('address',    sql.VarChar(500), row['address']?.trim() || null)
                        .input('pincode',    sql.VarChar(10),  row['pincode']?.trim() || null)
                        .input('city',       sql.VarChar(100), row['city']?.trim() || null)
                        .input('state',      sql.VarChar(100), row['state']?.trim() || null)
                        .query(`
                            INSERT INTO clients (
                                ucc, dob, mobile, email, client_name,
                                pan, dp_id, bo_id, account_status,
                                nse_cm, nse_fo, nse_cd,
                                bse_cm, bse_fo, bse_cd, mcx_fo,
                                address, pincode, city, state,
                                is_active, last_synced_at
                            ) VALUES (
                                @ucc, @dob, @mobile, @email, @clientName,
                                @pan, @dpId, @boId, @accStatus,
                                @nseCm, @nseFo, @nseCd,
                                @bseCm, @bseFo, @bseCd, @mcxFo,
                                @address, @pincode, @city, @state,
                                1, GETDATE()
                            )
                        `);
                    inserted++;
                }
            } catch (rowErr) {
                console.warn('[Client Upload] Row error:', rowErr.message);
                errors.push(`Error on ${row['ucc'] || 'unknown'}: ${rowErr.message}`);
                skipped++;
            }
        }

        // Audit log
        await pool.request()
            .input('adminId', sql.Int,     req.admin.adminId)
            .input('action',  sql.VarChar, 'CLIENT_BULK_UPLOAD')
            .input('details', sql.VarChar, `${req.file?.originalname || 'file'} — ${inserted} inserted, ${updated} updated, ${skipped} skipped`)
            .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);

        console.log(`[Client Upload] ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
        if (errors.length) console.warn('[Client Upload] Errors:', errors);

        return res.json({
            success:    true,
            total_rows: rows.length,
            inserted,
            updated,
            skipped,
            errors,
            message: `Processed ${rows.length} rows — ${inserted} new, ${updated} updated, ${skipped} skipped`
        });

    } catch (err) {
        safeUnlink(req.file?.path);
        console.error('[Client Upload] Error:', err);
        return res.status(500).json({ error: 'Failed to process file: ' + err.message });
    }
});

// ─── GET /api/admin/clients ───────────────────────────────────────────────────
router.get('/', adminAuthenticate, async (req, res) => {
    try {
        const page   = parseInt(req.query.page)  || 1;
        const limit  = parseInt(req.query.limit) || 50;
        const search = req.query.search?.trim()  || '';
        const offset = (page - 1) * limit;

        const pool   = await getConnection();
        const result = await pool.request()
            .input('search', sql.VarChar(100), `%${search}%`)
            .input('offset', sql.Int,          offset)
            .input('limit',  sql.Int,          limit)
            .query(`
                SELECT
                    client_id, ucc, client_name, email, mobile,
                    account_status, is_active,
                    nse_cm, nse_fo, bse_cm, bse_fo, mcx_fo,
                    created_at, last_synced_at
                FROM clients
                WHERE (@search = '%%' OR ucc LIKE @search OR client_name LIKE @search OR email LIKE @search)
                ORDER BY created_at DESC
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
            `);

        const countRes = await pool.request()
            .input('search', sql.VarChar(100), `%${search}%`)
            .query(`SELECT COUNT(*) AS total FROM clients WHERE (@search = '%%' OR ucc LIKE @search OR client_name LIKE @search OR email LIKE @search)`);

        return res.json({
            success: true,
            clients: result.recordset,
            total:   countRes.recordset[0].total,
            page,
            limit
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch clients.' });
    }
});

// ─── POST /api/admin/clients/create ──────────────────────────────────────────
// Create single client (called by BMS Windows Service)
router.post('/create', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.BMS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    const {
        ucc, dob, mobile, email, client_name,
        pan, dp_id, bo_id, account_status,
        nse_cm, nse_fo, nse_cd,
        bse_cm, bse_fo, bse_cd, mcx_fo,
        address, pincode, city, state
    } = req.body;

    // Required field validation
    if (!ucc || !dob || !mobile || !email || !client_name) {
        return res.status(400).json({
            error: 'Missing required fields.',
            required: ['ucc', 'dob', 'mobile', 'email', 'client_name']
        });
    }

    try {
        const pool = await getConnection();

        // Check if UCC already exists
        const existing = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.toString().toUpperCase().trim())
            .query('SELECT client_id FROM clients WHERE ucc = @ucc');

        if (existing.recordset.length > 0) {
            return res.status(409).json({
                error: `Client with UCC ${ucc} already exists. Use /update to modify.`,
                client_id: existing.recordset[0].client_id
            });
        }

        const result = await pool.request()
            .input('ucc',          sql.VarChar(20),  ucc.toString().toUpperCase().trim())
            .input('dob',          sql.Date,          new Date(dob))
            .input('mobile',       sql.VarChar(15),  mobile?.toString().trim())
            .input('email',        sql.VarChar(100), email?.toString().trim().toLowerCase())
            .input('clientName',   sql.VarChar(200), client_name?.toString().trim())
            .input('pan',          sql.VarChar(10),  pan?.toString().trim() || null)
            .input('dpId',         sql.VarChar(20),  dp_id?.toString().trim() || null)
            .input('boId',         sql.VarChar(20),  bo_id?.toString().trim() || null)
            .input('accStatus',    sql.VarChar(20),  account_status?.toString().trim() || 'ACTIVE')
            .input('nseCm',        sql.Bit,          nse_cm  ? 1 : 0)
            .input('nseFo',        sql.Bit,          nse_fo  ? 1 : 0)
            .input('nseCd',        sql.Bit,          nse_cd  ? 1 : 0)
            .input('bseCm',        sql.Bit,          bse_cm  ? 1 : 0)
            .input('bseFo',        sql.Bit,          bse_fo  ? 1 : 0)
            .input('bseCd',        sql.Bit,          bse_cd  ? 1 : 0)
            .input('mcxFo',        sql.Bit,          mcx_fo  ? 1 : 0)
            .input('address',      sql.VarChar(500), address?.toString().trim() || null)
            .input('pincode',      sql.VarChar(10),  pincode?.toString().trim() || null)
            .input('city',         sql.VarChar(100), city?.toString().trim() || null)
            .input('state',        sql.VarChar(100), state?.toString().trim() || null)
            .query(`
                INSERT INTO clients (
                    ucc, dob, mobile, email, client_name,
                    pan, dp_id, bo_id, account_status,
                    nse_cm, nse_fo, nse_cd,
                    bse_cm, bse_fo, bse_cd, mcx_fo,
                    address, pincode, city, state,
                    is_active, last_synced_at
                )
                OUTPUT INSERTED.client_id
                VALUES (
                    @ucc, @dob, @mobile, @email, @clientName,
                    @pan, @dpId, @boId, @accStatus,
                    @nseCm, @nseFo, @nseCd,
                    @bseCm, @bseFo, @bseCd, @mcxFo,
                    @address, @pincode, @city, @state,
                    1, GETDATE()
                )
            `);

        const clientId = result.recordset[0].client_id;
        console.log(`[Client Create] New client: ${ucc} (ID: ${clientId})`);

        return res.status(201).json({
            success:   true,
            client_id: clientId,
            ucc:       ucc.toUpperCase(),
            message:   `Client ${ucc} created successfully`
        });

    } catch (err) {
        console.error('[Client Create] Error:', err.message);
        return res.status(500).json({ error: 'Failed to create client: ' + err.message });
    }
});

// ─── PUT /api/admin/clients/update/:ucc ──────────────────────────────────────
// Update existing client (called by BMS Windows Service)
router.put('/update/:ucc', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.BMS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    const ucc = req.params.ucc?.toString().toUpperCase().trim();
    if (!ucc) return res.status(400).json({ error: 'UCC is required.' });

    const {
        dob, mobile, email, client_name,
        pan, dp_id, bo_id, account_status, is_active,
        nse_cm, nse_fo, nse_cd,
        bse_cm, bse_fo, bse_cd, mcx_fo,
        address, pincode, city, state
    } = req.body;

    try {
        const pool = await getConnection();

        // Check client exists
        const existing = await pool.request()
            .input('ucc', sql.VarChar(20), ucc)
            .query('SELECT client_id FROM clients WHERE ucc = @ucc');

        if (existing.recordset.length === 0) {
            return res.status(404).json({
                error: `Client with UCC ${ucc} not found. Use /create to add new client.`
            });
        }

        // Build dynamic update — only update fields that are provided
        const updates = [];
        const request = pool.request().input('ucc', sql.VarChar(20), ucc);

        if (dob          !== undefined) { updates.push('dob = @dob');                   request.input('dob',        sql.Date,         new Date(dob)); }
        if (mobile       !== undefined) { updates.push('mobile = @mobile');             request.input('mobile',     sql.VarChar(15),  mobile?.toString().trim()); }
        if (email        !== undefined) { updates.push('email = @email');               request.input('email',      sql.VarChar(100), email?.toString().trim().toLowerCase()); }
        if (client_name  !== undefined) { updates.push('client_name = @clientName');    request.input('clientName', sql.VarChar(200), client_name?.toString().trim()); }
        if (pan          !== undefined) { updates.push('pan = @pan');                   request.input('pan',        sql.VarChar(10),  pan?.toString().trim() || null); }
        if (dp_id        !== undefined) { updates.push('dp_id = @dpId');               request.input('dpId',       sql.VarChar(20),  dp_id?.toString().trim() || null); }
        if (bo_id        !== undefined) { updates.push('bo_id = @boId');               request.input('boId',       sql.VarChar(20),  bo_id?.toString().trim() || null); }
        if (account_status !== undefined) { updates.push('account_status = @accStatus'); request.input('accStatus',  sql.VarChar(20),  account_status?.toString().trim()); }
        if (is_active    !== undefined) { updates.push('is_active = @isActive');        request.input('isActive',   sql.Bit,          is_active ? 1 : 0); }
        if (nse_cm       !== undefined) { updates.push('nse_cm = @nseCm');             request.input('nseCm',      sql.Bit,          nse_cm  ? 1 : 0); }
        if (nse_fo       !== undefined) { updates.push('nse_fo = @nseFo');             request.input('nseFo',      sql.Bit,          nse_fo  ? 1 : 0); }
        if (nse_cd       !== undefined) { updates.push('nse_cd = @nseCd');             request.input('nseCd',      sql.Bit,          nse_cd  ? 1 : 0); }
        if (bse_cm       !== undefined) { updates.push('bse_cm = @bseCm');             request.input('bseCm',      sql.Bit,          bse_cm  ? 1 : 0); }
        if (bse_fo       !== undefined) { updates.push('bse_fo = @bseFo');             request.input('bseFo',      sql.Bit,          bse_fo  ? 1 : 0); }
        if (bse_cd       !== undefined) { updates.push('bse_cd = @bseCd');             request.input('bseCd',      sql.Bit,          bse_cd  ? 1 : 0); }
        if (mcx_fo       !== undefined) { updates.push('mcx_fo = @mcxFo');             request.input('mcxFo',      sql.Bit,          mcx_fo  ? 1 : 0); }
        if (address      !== undefined) { updates.push('address = @address');           request.input('address',    sql.VarChar(500), address?.toString().trim() || null); }
        if (pincode      !== undefined) { updates.push('pincode = @pincode');           request.input('pincode',    sql.VarChar(10),  pincode?.toString().trim() || null); }
        if (city         !== undefined) { updates.push('city = @city');                 request.input('city',       sql.VarChar(100), city?.toString().trim() || null); }
        if (state        !== undefined) { updates.push('state = @state');               request.input('state',      sql.VarChar(100), state?.toString().trim() || null); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields provided to update.' });
        }

        // Always update last_synced_at and modified_at
        updates.push('last_synced_at = GETDATE()');
        updates.push('modified_at = GETDATE()');
        updates.push("modified_by = 'BMS_SYNC'");

        await request.query(`
            UPDATE clients
            SET ${updates.join(', ')}
            WHERE ucc = @ucc
        `);

        console.log(`[Client Update] Updated: ${ucc} — fields: ${updates.length - 3}`);

        return res.json({
            success: true,
            ucc,
            updated_fields: updates.length - 3,
            message: `Client ${ucc} updated successfully`
        });

    } catch (err) {
        console.error('[Client Update] Error:', err.message);
        return res.status(500).json({ error: 'Failed to update client: ' + err.message });
    }
});

// ─── POST /api/admin/clients/upsert ──────────────────────────────────────────
// Create or Update — single endpoint for BMS Windows Service
// If UCC exists → update, if not → create
router.post('/upsert', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.BMS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API key.' });
    }

    const {
        ucc, dob, mobile, email, client_name,
        pan, dp_id, bo_id, account_status, is_active,
        nse_cm, nse_fo, nse_cd,
        bse_cm, bse_fo, bse_cd, mcx_fo,
        address, pincode, city, state
    } = req.body;

    if (!ucc || !dob || !mobile || !email || !client_name) {
        return res.status(400).json({
            error: 'Missing required fields.',
            required: ['ucc', 'dob', 'mobile', 'email', 'client_name']
        });
    }

    try {
        const pool     = await getConnection();
        const cleanUcc = ucc.toString().toUpperCase().trim();

        const existing = await pool.request()
            .input('ucc', sql.VarChar(20), cleanUcc)
            .query('SELECT client_id FROM clients WHERE ucc = @ucc');

        const isNew = existing.recordset.length === 0;

        await pool.request()
            .input('ucc',        sql.VarChar(20),  cleanUcc)
            .input('dob',        sql.Date,          new Date(dob))
            .input('mobile',     sql.VarChar(15),  mobile?.toString().trim())
            .input('email',      sql.VarChar(100), email?.toString().trim().toLowerCase())
            .input('clientName', sql.VarChar(200), client_name?.toString().trim())
            .input('pan',        sql.VarChar(10),  pan?.toString().trim() || null)
            .input('dpId',       sql.VarChar(20),  dp_id?.toString().trim() || null)
            .input('boId',       sql.VarChar(20),  bo_id?.toString().trim() || null)
            .input('accStatus',  sql.VarChar(20),  account_status?.toString().trim() || 'ACTIVE')
            .input('isActive',   sql.Bit,          is_active !== undefined ? (is_active ? 1 : 0) : 1)
            .input('nseCm',      sql.Bit,          nse_cm  ? 1 : 0)
            .input('nseFo',      sql.Bit,          nse_fo  ? 1 : 0)
            .input('nseCd',      sql.Bit,          nse_cd  ? 1 : 0)
            .input('bseCm',      sql.Bit,          bse_cm  ? 1 : 0)
            .input('bseFo',      sql.Bit,          bse_fo  ? 1 : 0)
            .input('bseCd',      sql.Bit,          bse_cd  ? 1 : 0)
            .input('mcxFo',      sql.Bit,          mcx_fo  ? 1 : 0)
            .input('address',    sql.VarChar(500), address?.toString().trim() || null)
            .input('pincode',    sql.VarChar(10),  pincode?.toString().trim() || null)
            .input('city',       sql.VarChar(100), city?.toString().trim() || null)
            .input('state',      sql.VarChar(100), state?.toString().trim() || null)
            .query(`
                MERGE clients AS target
                USING (SELECT @ucc AS ucc) AS source ON target.ucc = source.ucc
                WHEN MATCHED THEN
                    UPDATE SET
                        dob = @dob, mobile = @mobile, email = @email,
                        client_name = @clientName, pan = @pan,
                        dp_id = @dpId, bo_id = @boId,
                        account_status = @accStatus, is_active = @isActive,
                        nse_cm = @nseCm, nse_fo = @nseFo, nse_cd = @nseCd,
                        bse_cm = @bseCm, bse_fo = @bseFo, bse_cd = @bseCd,
                        mcx_fo = @mcxFo,
                        address = @address, pincode = @pincode,
                        city = @city, state = @state,
                        last_synced_at = GETDATE(),
                        modified_at = GETDATE(),
                        modified_by = 'BMS_SYNC'
                WHEN NOT MATCHED THEN
                    INSERT (
                        ucc, dob, mobile, email, client_name,
                        pan, dp_id, bo_id, account_status, is_active,
                        nse_cm, nse_fo, nse_cd,
                        bse_cm, bse_fo, bse_cd, mcx_fo,
                        address, pincode, city, state,
                        last_synced_at
                    ) VALUES (
                        @ucc, @dob, @mobile, @email, @clientName,
                        @pan, @dpId, @boId, @accStatus, @isActive,
                        @nseCm, @nseFo, @nseCd,
                        @bseCm, @bseFo, @bseCd, @mcxFo,
                        @address, @pincode, @city, @state,
                        GETDATE()
                    );
            `);

        console.log(`[Client Upsert] ${isNew ? 'Created' : 'Updated'}: ${cleanUcc}`);

        return res.status(isNew ? 201 : 200).json({
            success: true,
            ucc:     cleanUcc,
            action:  isNew ? 'created' : 'updated',
            message: `Client ${cleanUcc} ${isNew ? 'created' : 'updated'} successfully`
        });

    } catch (err) {
        console.error('[Client Upsert] Error:', err.message);
        return res.status(500).json({ error: 'Failed to upsert client: ' + err.message });
    }
});
module.exports = router;