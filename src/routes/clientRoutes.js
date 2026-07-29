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
        .replace(/^﻿/, '')       // Remove BOM
        .replace(/ /g, ' ')      // Replace non-breaking spaces
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
            row[h] = (vals[idx] || '').trim().replace(/ /g, ' ');
        });
        rows.push(row);
    }
    return rows;
}

function toBit(val) {
    if (val === '1' || val === 'true' || val === 'yes') return 1;
    return 0;
}

// ─── DOB fix (2026-07-29): restricted to DD-MM-YYYY only ────────────────────
// Previously also accepted DD/MM/YYYY and YYYY-MM-DD, which is ambiguous
// against a 20,000+ row master file coming from an external source -- a
// stray YYYY-MM-DD row could silently parse as a different date than
// intended if the source system's convention differs. Now strictly
// DD-MM-YYYY (hyphen-separated); anything else returns null, which the
// upload loop already treats as a missing required field and skips the row
// (visible in the returned `errors` array), so behaviour on bad input is
// unchanged -- only the set of formats considered *valid* has narrowed.
function toDate(val) {
    if (!val || val.trim() === '') return null;
    val = val.trim();

    // DD-MM-YYYY only
    if (/^\d{2}-\d{2}-\d{4}$/.test(val)) {
        const [d, m, y] = val.split('-');
        const date = new Date(`${y}-${m}-${d}`);
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
                const ucc  = row['ucc']?.toUpperCase().trim().replace(/ /g, '');
                const dob  = toDate(row['dob']);
                const name = row['client_name']?.trim().replace(/ /g, '');

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
                        .input('terminal',   sql.VarChar(10),  row['terminal']?.trim().toUpperCase() || null)
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
                                terminal = @terminal,
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
                        .input('terminal',   sql.VarChar(10),  row['terminal']?.trim().toUpperCase() || null)
                        .query(`
                            INSERT INTO clients (
                                ucc, dob, mobile, email, client_name,
                                pan, dp_id, bo_id, account_status,
                                nse_cm, nse_fo, nse_cd,
                                bse_cm, bse_fo, bse_cd, mcx_fo,
                                address, pincode, city, state, terminal,
                                is_active, last_synced_at
                            ) VALUES (
                                @ucc, @dob, @mobile, @email, @clientName,
                                @pan, @dpId, @boId, @accStatus,
                                @nseCm, @nseFo, @nseCd,
                                @bseCm, @bseFo, @bseCd, @mcxFo,
                                @address, @pincode, @city, @state, @terminal,
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

        // Upload history (2026-07-29): structured record of this run, feeding
        // the new Client Upload history table on the frontend -- separate
        // from the admin_logs entry above (which stays as-is for the
        // existing Audit Logs page) so the filename/counts don't need to be
        // parsed back out of a free-text details string.
        await pool.request()
            .input('filename',  sql.VarChar(255), req.file?.originalname || 'unknown.csv')
            .input('adminId',   sql.Int,          req.admin.adminId)
            .input('totalRows', sql.Int,          rows.length)
            .input('inserted',  sql.Int,          inserted)
            .input('updated',   sql.Int,          updated)
            .input('skipped',   sql.Int,          skipped)
            .query(`
                INSERT INTO client_upload_history (filename, admin_id, total_rows, inserted, updated, skipped)
                VALUES (@filename, @adminId, @totalRows, @inserted, @updated, @skipped)
            `);

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
        address, pincode, city, state, terminal
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
            .input('terminal',     sql.VarChar(10),  terminal?.toString().trim().toUpperCase() || null)
            .query(`
                INSERT INTO clients (
                    ucc, dob, mobile, email, client_name,
                    pan, dp_id, bo_id, account_status,
                    nse_cm, nse_fo, nse_cd,
                    bse_cm, bse_fo, bse_cd, mcx_fo,
                    address, pincode, city, state, terminal,
                    is_active, last_synced_at
                )
                OUTPUT INSERTED.client_id
                VALUES (
                    @ucc, @dob, @mobile, @email, @clientName,
                    @pan, @dpId, @boId, @accStatus,
                    @nseCm, @nseFo, @nseCd,
                    @bseCm, @bseFo, @bseCd, @mcxFo,
                    @address, @pincode, @city, @state, @terminal,
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
        address, pincode, city, state, terminal
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
        if (terminal     !== undefined) { updates.push('terminal = @terminal');         request.input('terminal',   sql.VarChar(10),  terminal ? terminal.toString().trim().toUpperCase() : null); }

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
        address, pincode, city, state, terminal
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
            .input('terminal',   sql.VarChar(10),  terminal?.toString().trim().toUpperCase() || null)
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
                        terminal = @terminal,
                        last_synced_at = GETDATE(),
                        modified_at = GETDATE(),
                        modified_by = 'BMS_SYNC'
                WHEN NOT MATCHED THEN
                    INSERT (
                        ucc, dob, mobile, email, client_name,
                        pan, dp_id, bo_id, account_status, is_active,
                        nse_cm, nse_fo, nse_cd,
                        bse_cm, bse_fo, bse_cd, mcx_fo,
                        address, pincode, city, state, terminal,
                        last_synced_at
                    ) VALUES (
                        @ucc, @dob, @mobile, @email, @clientName,
                        @pan, @dpId, @boId, @accStatus, @isActive,
                        @nseCm, @nseFo, @nseCd,
                        @bseCm, @bseFo, @bseCd, @mcxFo,
                        @address, @pincode, @city, @state, @terminal,
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

// ─── GET /api/admin/clients/search ───────────────────────────────────────────
// Client Search (2026-07-22): search by any one of UCC / Mobile / Email /
// BO ID / PAN. If more than one field is filled in, they are AND'd together
// -- harmless in practice since an admin usually fills exactly one box at a
// time. Returns a results list (there can be more than one match, e.g. a
// partial UCC) for the frontend to show before drilling into full detail via
// GET /:ucc/detail below.
router.get('/search', adminAuthenticate, async (req, res) => {
    try {
        const { ucc, mobile, email, bo_id, pan } = req.query;

        if (!ucc?.trim() && !mobile?.trim() && !email?.trim() && !bo_id?.trim() && !pan?.trim()) {
            return res.status(400).json({ error: 'Provide at least one of: ucc, mobile, email, bo_id, pan.' });
        }

        const pool       = await getConnection();
        const request     = pool.request();
        const conditions = [];

        if (ucc?.trim()) {
            request.input('ucc', sql.VarChar(20), `%${ucc.trim().toUpperCase()}%`);
            conditions.push('UPPER(ucc) LIKE @ucc');
        }
        if (mobile?.trim()) {
            request.input('mobile', sql.VarChar(15), `%${mobile.trim()}%`);
            conditions.push('mobile LIKE @mobile');
        }
        if (email?.trim()) {
            request.input('email', sql.VarChar(100), `%${email.trim().toLowerCase()}%`);
            conditions.push('LOWER(email) LIKE @email');
        }
        if (bo_id?.trim()) {
            request.input('boId', sql.VarChar(20), `%${bo_id.trim().toUpperCase()}%`);
            conditions.push('UPPER(bo_id) LIKE @boId');
        }
        if (pan?.trim()) {
            request.input('pan', sql.VarChar(10), `%${pan.trim().toUpperCase()}%`);
            conditions.push('UPPER(pan) LIKE @pan');
        }

        const result = await request.query(`
            SELECT TOP 100
                client_id, ucc, client_name, email, mobile, pan, bo_id, dp_id,
                account_status, is_active, terminal, created_at
            FROM clients
            WHERE ${conditions.join(' AND ')}
            ORDER BY client_name
        `);

        return res.json({ success: true, clients: result.recordset, count: result.recordset.length });
    } catch (err) {
        console.error('[Client Search] Error:', err.message);
        return res.status(500).json({ error: 'Search failed: ' + err.message });
    }
});

// ─── GET /api/admin/clients/upload-history ───────────────────────────────────
// Client Upload history (2026-07-29): full history of CSV bulk-upload runs
// -- filename, who ran it, when, and the resulting counts -- with an
// optional ?from=YYYY-MM-DD&to=YYYY-MM-DD date-range filter. Both params are
// optional and backward compatible; omitting either (or both) returns the
// full unfiltered history newest-first, same pattern already used for
// GET /api/admin/control/communications. `to` is inclusive of the whole day.
router.get('/upload-history', adminAuthenticate, async (req, res) => {
    try {
        const pool    = await getConnection();
        const request = pool.request();
        const conditions = [];

        if (req.query.from) {
            request.input('fromDate', sql.Date, req.query.from);
            conditions.push('h.uploaded_at >= @fromDate');
        }
        if (req.query.to) {
            request.input('toDate', sql.Date, req.query.to);
            conditions.push('h.uploaded_at < DATEADD(DAY, 1, @toDate)');
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await request.query(`
            SELECT h.id, h.filename, h.uploaded_at,
                   h.total_rows, h.inserted, h.updated, h.skipped,
                   a.full_name AS uploaded_by
            FROM client_upload_history h
            LEFT JOIN admin_users a ON h.admin_id = a.admin_id
            ${whereClause}
            ORDER BY h.uploaded_at DESC
        `);

        return res.json({ success: true, history: result.recordset });
    } catch (err) {
        console.error('[Upload History] Error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch upload history.' });
    }
});

// ─── GET /api/admin/clients/:ucc/detail ──────────────────────────────────────
// Client Search (2026-07-22): full client detail for the results-to-detail
// drill-down, including the 4-state (Active/Reactive/Suspend/Closed) segment
// status from the new client_segment_status table (see
// client_segment_status.migration.sql). Display-only -- nothing here writes
// to client_segment_status; that comes in a later round. Does not read or
// touch the existing nse_cm/nse_fo/etc bit flags for anything other than
// showing them alongside the new segment-status table for reference.
router.get('/:ucc/detail', adminAuthenticate, async (req, res) => {
    try {
        const ucc = req.params.ucc?.toUpperCase().trim();
        if (!ucc) return res.status(400).json({ error: 'UCC is required.' });

        const pool = await getConnection();
        const clientRes = await pool.request()
            .input('ucc', sql.VarChar(20), ucc)
            .query(`
                SELECT client_id, ucc, client_name, email, mobile, dob, pan,
                       dp_id, bo_id, account_status, is_active,
                       nse_cm, nse_fo, nse_cd, bse_cm, bse_fo, bse_cd, mcx_fo,
                       address, pincode, city, state, terminal,
                       created_at, modified_at, modified_by, last_synced_at
                FROM clients
                WHERE ucc = @ucc
            `);

        if (clientRes.recordset.length === 0) {
            return res.status(404).json({ error: `Client with UCC ${ucc} not found.` });
        }

        const client = clientRes.recordset[0];

        const segRes = await pool.request()
            .input('clientId', sql.Int, client.client_id)
            .query(`
                SELECT exchange, segment, status, updated_at, updated_by
                FROM client_segment_status
                WHERE client_id = @clientId
                ORDER BY exchange, segment
            `);

        return res.json({ success: true, client, segment_status: segRes.recordset });
    } catch (err) {
        console.error('[Client Detail] Error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch client detail: ' + err.message });
    }
});

module.exports = router;