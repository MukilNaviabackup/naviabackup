const express = require('express');
const router = express.Router();
const { getConnection, sql } = require('../config/database');

function validateSyncKey(req, res, next) {
    const syncKey = req.headers['x-sync-key'];
    if (!syncKey || syncKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid sync key.' });
    }
    next();
}

// API 1 — Bulk client sync
router.post('/clients', validateSyncKey, async (req, res) => {
    const { clients } = req.body;
    if (!clients || !Array.isArray(clients) || clients.length === 0) {
        return res.status(400).json({ error: 'clients array is required.' });
    }
    try {
        const pool = await getConnection();
        let inserted = 0;
        let updated = 0;
        for (const client of clients) {
            if (!client.ucc || !client.dob || !client.mobile) continue;
            await pool.request()
                .input('ucc', sql.VarChar, client.ucc.toString().toUpperCase().trim())
                .input('dob', sql.Date, client.dob)
                .input('mobile', sql.VarChar, client.mobile.toString().trim())
                .input('email', sql.VarChar, client.email || '')
                .input('name', sql.VarChar, client.client_name || client.ucc)
                .input('isActive', sql.Bit, client.is_active === 1 || client.is_active === true ? 1 : 0)
                .query(`
                    MERGE clients AS target
                    USING (SELECT @ucc AS ucc) AS source ON target.ucc = source.ucc
                    WHEN MATCHED THEN
                        UPDATE SET dob=@dob, mobile=@mobile, email=@email,
                            client_name=@name, is_active=@isActive,
                            last_synced_at=GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (ucc, dob, mobile, email, client_name, is_active, last_synced_at)
                        VALUES (@ucc, @dob, @mobile, @email, @name, @isActive, GETDATE());
                `);
            inserted++;
        }
        return res.json({
            success: true,
            message: 'Client sync completed',
            inserted, updated,
            total: clients.length,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Client sync error:', err);
        return res.status(500).json({ error: 'Sync failed.' });
    }
});

// API 2 — Single client update
router.post('/client', validateSyncKey, async (req, res) => {
    const { ucc, dob, mobile, email, client_name, is_active } = req.body;
    if (!ucc || !dob || !mobile) {
        return res.status(400).json({ error: 'ucc, dob and mobile are required.' });
    }
    try {
        const pool = await getConnection();
        await pool.request()
            .input('ucc', sql.VarChar, ucc.toString().toUpperCase().trim())
            .input('dob', sql.Date, dob)
            .input('mobile', sql.VarChar, mobile.toString().trim())
            .input('email', sql.VarChar, email || '')
            .input('name', sql.VarChar, client_name || ucc)
            .input('isActive', sql.Bit, is_active === 1 ? 1 : 0)
            .query(`
                MERGE clients AS target
                USING (SELECT @ucc AS ucc) AS source ON target.ucc = source.ucc
                WHEN MATCHED THEN
                    UPDATE SET dob=@dob, mobile=@mobile, email=@email,
                        client_name=@name, is_active=@isActive,
                        last_synced_at=GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (ucc, dob, mobile, email, client_name, is_active, last_synced_at)
                    VALUES (@ucc, @dob, @mobile, @email, @name, @isActive, GETDATE());
            `);
        return res.json({
            success: true,
            message: `Client ${ucc} synced successfully`,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        return res.status(500).json({ error: 'Sync failed.' });
    }
});

// API 3 — Bulk holdings sync (BMS pushes holdings data)
router.post('/holdings', validateSyncKey, async (req, res) => {
    const { ucc, holdings } = req.body;
    if (!ucc || !holdings || !Array.isArray(holdings)) {
        return res.status(400).json({ error: 'ucc and holdings array are required.' });
    }
    try {
        const pool = await getConnection();

        // Clear existing holdings for this client
        await pool.request()
            .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
            .query(`DELETE FROM positions 
                    WHERE ucc = @ucc AND position_type = 'HOLDINGS'`);

        let count = 0;
        for (const holding of holdings) {
            if (!holding.balance || holding.balance <= 0) continue;
            const symbolName = (holding.compname || holding.isincd || 'UNKNOWN').substring(0, 50);
            await pool.request()
                .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
                .input('symbol', sql.VarChar, symbolName)
                .input('isincd', sql.VarChar, holding.isincd || '')
                .input('qty', sql.Int, Math.floor(holding.balance))
                .input('closerate', sql.Decimal(10, 2), holding.closerate || 0)
                .input('holdingValue', sql.Decimal(15, 2), holding.holding || 0)
                .query(`INSERT INTO positions
                        (ucc, exchange, segment, symbol, position_type,
                         buy_qty, sell_qty, net_qty, avg_price, ltp, pnl,
                         squareoff_placed, last_updated)
                        VALUES (@ucc, 'NSE', 'CM', @symbol, 'HOLDINGS',
                                @qty, 0, @qty, @closerate, @closerate, 0,
                                0, GETDATE())`);
            count++;
        }

        console.log(`Holdings synced for ${ucc}: ${count} records`);
        return res.json({
            success: true,
            message: `Holdings synced for ${ucc}`,
            records_synced: count,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Holdings sync error:', err);
        return res.status(500).json({ error: 'Holdings sync failed.' });
    }
});

// API 4 — Bulk holdings for all clients at once
router.post('/holdings/bulk', validateSyncKey, async (req, res) => {
    const { clients_holdings } = req.body;
    if (!clients_holdings || !Array.isArray(clients_holdings)) {
        return res.status(400).json({ error: 'clients_holdings array is required.' });
    }
    try {
        const pool = await getConnection();
        let totalRecords = 0;
        let clientsProcessed = 0;

        for (const clientData of clients_holdings) {
            const { ucc, holdings } = clientData;
            if (!ucc || !holdings || !Array.isArray(holdings)) continue;

            // Clear existing holdings
            await pool.request()
                .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
                .query(`DELETE FROM positions 
                        WHERE ucc = @ucc AND position_type = 'HOLDINGS'`);

            for (const holding of holdings) {
                if (!holding.balance || holding.balance <= 0) continue;
                const symbolName = (holding.compname || holding.isincd || 'UNKNOWN').substring(0, 50);
                await pool.request()
                    .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
                    .input('symbol', sql.VarChar, symbolName)
                    .input('isincd', sql.VarChar, holding.isincd || '')
                    .input('qty', sql.Int, Math.floor(holding.balance))
                    .input('closerate', sql.Decimal(10, 2), holding.closerate || 0)
                    .input('holdingValue', sql.Decimal(15, 2), holding.holding || 0)
                    .query(`INSERT INTO positions
                            (ucc, exchange, segment, symbol, position_type,
                             buy_qty, sell_qty, net_qty, avg_price, ltp, pnl,
                             squareoff_placed, last_updated)
                            VALUES (@ucc, 'NSE', 'CM', @symbol, 'HOLDINGS',
                                    @qty, 0, @qty, @closerate, @closerate, 0,
                                    0, GETDATE())`);
                totalRecords++;
            }
            clientsProcessed++;
        }

        return res.json({
            success: true,
            message: 'Bulk holdings sync completed',
            clients_processed: clientsProcessed,
            total_records: totalRecords,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Bulk holdings error:', err);
        return res.status(500).json({ error: 'Bulk holdings sync failed.' });
    }
});

// API 5 — Sync status
router.get('/status', validateSyncKey, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .query(`SELECT 
                COUNT(*) as total_clients,
                MAX(last_synced_at) as last_sync,
                SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) as active_clients
                FROM clients`);
        const holdingsResult = await pool.request()
            .query(`SELECT COUNT(*) as total_holdings FROM positions 
                    WHERE position_type = 'HOLDINGS'`);
        const data = result.recordset[0];
        return res.json({
            success: true,
            last_sync: data.last_sync,
            total_clients: data.total_clients,
            active_clients: data.active_clients,
            total_holdings_records: holdingsResult.recordset[0].total_holdings,
            status: 'healthy'
        });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch status.' });
    }
});

module.exports = router;