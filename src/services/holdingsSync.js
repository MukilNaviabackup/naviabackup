const { getConnection, sql } = require('../config/database');
require('dotenv').config();

const SHAREPRO_HOLDINGS_URL = 'https://backoffice.navia.co.in/shrdbms/dotnet/api/stansoft/GetDpHoldingData';
const SHAREPRO_API_KEY = 'e0JDQzRGQzRCLTU1QTEtNEM0Qi04M0E1LURGRjA0NERCNzgxRX0=';

function getTodayDate() {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

async function fetchHoldingsForClient(ucc) {
    try {
        const response = await fetch(SHAREPRO_HOLDINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: SHAREPRO_API_KEY,
                ucc: ucc,
                segments: 'NSDL',
                date: getTodayDate()
            })
        });
        if (!response.ok) {
            console.log(`API error for ${ucc}: ${response.status}`);
            return [];
        }
        const data = await response.json();
        console.log(`Raw holdings for ${ucc}:`, JSON.stringify(data));
        return data.curdata || [];
    } catch (err) {
        console.error(`Fetch error for ${ucc}:`, err.message);
        return [];
    }
}

async function syncHoldingsForClient(ucc) {
    try {
        const holdings = await fetchHoldingsForClient(ucc);
        if (!holdings || holdings.length === 0) {
            console.log(`No holdings found for ${ucc}`);
            return 0;
        }
        const pool = await getConnection();

        // Clear existing holdings
        await pool.request()
            .input('ucc', sql.VarChar, ucc)
            .query(`DELETE FROM positions WHERE ucc = @ucc AND position_type = 'HOLDINGS'`);

        let count = 0;
        for (const holding of holdings) {
            if (!holding.balance || holding.balance <= 0) continue;
            const symbolName = (holding.compname || holding.isincd || 'UNKNOWN').substring(0, 50);
            await pool.request()
                .input('ucc', sql.VarChar, ucc)
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
        return count;
    } catch (err) {
        console.error(`Sync error for ${ucc}:`, err.message);
        return 0;
    }
}

async function syncAllClientsHoldings() {
    console.log('Starting holdings sync:', new Date().toISOString());
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .query('SELECT ucc FROM clients WHERE is_active = 1');
        const clients = result.recordset;
        let totalSynced = 0;
        let successCount = 0;
        for (const client of clients) {
            const count = await syncHoldingsForClient(client.ucc);
            successCount++;
            totalSynced += count;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        console.log(`Sync complete. Clients: ${successCount}, Records: ${totalSynced}`);
        return { successCount, totalSynced };
    } catch (err) {
        console.error('Sync failed:', err.message);
        throw err;
    }
}

module.exports = { syncAllClientsHoldings, syncHoldingsForClient, fetchHoldingsForClient };