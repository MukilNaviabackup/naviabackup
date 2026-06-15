'use strict';
const express = require('express');
const router  = express.Router();
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');
require('dotenv').config();

// GET /api/admin/slice-qty
router.get('/', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT id, symbol, exchange, slice_qty, updated_by, updated_at
            FROM slice_qty_master
            ORDER BY exchange, symbol
        `);
        return res.json({ success: true, sliceQty: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch slice quantities.' });
    }
});

// PUT /api/admin/slice-qty/:symbol
router.put('/:symbol', adminAuthenticate, async (req, res) => {
    const { symbol }    = req.params;
    const { slice_qty } = req.body;
    if (!slice_qty || isNaN(slice_qty) || slice_qty <= 0) {
        return res.status(400).json({ error: 'Invalid slice quantity.' });
    }
    try {
        const pool = await getConnection();
        await pool.request()
            .input('symbol',    sql.VarChar(20), symbol.toUpperCase())
            .input('slice_qty', sql.Int,         parseInt(slice_qty))
            .input('updatedBy', sql.VarChar(100), req.admin.name || req.admin.username || 'admin')
            .query(`
                UPDATE slice_qty_master
                SET slice_qty  = @slice_qty,
                    updated_by = @updatedBy,
                    updated_at = GETDATE()
                WHERE symbol = @symbol
            `);
        return res.json({ success: true, message: 'Slice quantity updated.' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update slice quantity.' });
    }
});

module.exports = router;