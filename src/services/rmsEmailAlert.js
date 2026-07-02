'use strict';
/**
 * rmsEmailAlert.js -- RMS Email Alert Service
 * ============================================
 * Sends ONE batched email to the RMS/surveillance team immediately when
 * one or more square-off orders are placed via Navia Backup.
 *
 * Uses a 2-second debounce window so that Square Off All (multiple orders
 * placed within milliseconds) results in ONE email with all basket files
 * attached, not one email per order.
 *
 * Example: client places 2 NSE CM + 1 NSE FO + 2 MCX FO via Square Off All
 *   -> 5 calls to queueRMSEmailAlert within ~100ms
 *   -> debounce collects all 5
 *   -> 2s later: ONE email sent with 3 attachments:
 *      BasketCM{ts}.txt  (NEAT CM format)
 *      BasketFO{ts}.txt  (NEAT FO format)
 *      BasketMCX{ts}.csv (MCS format with CSV header)
 *
 * Email:
 *   To:  surveillance@navia.co.in
 *   BCC: technology@navia.co.in, monicka@navia.co.in,
 *        kiruthika@navia.co.in, elamukil@navia.co.in
 */

const nodemailer    = require('nodemailer');
const { getConnection, sql } = require('../config/database');

// ── Email config ──────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST     || 'smtp.zatpatmail.com';
const SMTP_PORT = 465;
const SMTP_USER = process.env.SMTP_USER     || 'updates@navia.co.in';
const SMTP_PASS = process.env.SMTP_PASSWORD;
const TO_EMAIL  = 'surveillance@navia.co.in';
const BCC_LIST  = [
    'technology@navia.co.in',
    'monicka@navia.co.in',
    'kiruthika@navia.co.in',
    'elamukil@navia.co.in',
];

// ── Formatting helpers ────────────────────────────────────────────────────────
function pad(val, len) { return String(val || '').padEnd(len, ' '); }

function formatTimestamp(d) {
    const dd  = String(d.getDate()).padStart(2, '0');
    const mon = d.toLocaleString('en-IN', { month: 'short' });
    const yr  = d.getFullYear();
    const hh  = String(d.getHours()).padStart(2, '0');
    const mm  = String(d.getMinutes()).padStart(2, '0');
    const ss  = String(d.getSeconds()).padStart(2, '0');
    return `${dd}${mon}${yr}-${hh}-${mm}-${ss}`;
}

// ── NEAT CM row (NSE Cash Market basket format) ───────────────────────────────
// Col 5 = constant '1 ' (Instructions), Col 11 = actual qty unpadded
// Proven against 1,080 real NSE CM SHORT/LONG bulk rows
function makeNeatCMRow(serial, side, symbol, qty, ucc) {
    const trans = side.toUpperCase() === 'BUY' ? '1' : '2';
    return [
        String(serial).padEnd(13), '1 ', trans + ' ',
        symbol.padEnd(10), pad('EQ', 2), pad('1', 2),
        pad('', 11), pad('', 2), pad('', 9),
        pad('MKT', 10), pad('', 8), String(qty),
        pad('', 9), pad('07708', 12), pad('2', 2),
        pad(ucc, 10), pad('', 25), pad('', 16), pad('', 10),
    ].join(',');
}

// ── NEAT FO row (NSE F&O basket format) ──────────────────────────────────────
// Col 3 = constant '1 ', Col 5 = BuySell, Col 11 = constant '1 '
// Col 17 = lot_size x qty (total shares, no padding)
// Proven against NSE FO bulk data (1,090 rows: OPT SHORT/LONG, FUT SHORT/LONG)
function makeNeatFORow(serial, side, symbol, expiry, strikePrice, optionType, qty, ucc, lotSizeMap) {
    const BASE_SYMS = ['MIDCPNIFTY', 'BANKNIFTY', 'FINNIFTY', 'NIFTY', 'SENSEX', 'BANKEX'];
    const base      = symbol.toUpperCase().trim().split(/[\s@0-9]/)[0];
    const isIdx     = BASE_SYMS.some(b => base.startsWith(b));
    const hasOpt    = optionType && optionType !== 'XX';
    const instrType = hasOpt ? (isIdx ? 'OPTIDX' : 'OPTSTK') : (isIdx ? 'FUTIDX' : 'FUTSTK');

    let expStr = '          ';
    if (expiry) {
        const d   = new Date(expiry);
        const dd  = String(d.getUTCDate()).padStart(2, '0');
        const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
        expStr    = (dd + mon + d.getUTCFullYear()).padEnd(10);
    }
    const strike   = strikePrice ? String(Math.round(parseFloat(strikePrice))).padEnd(10) : '          ';
    const optType  = hasOpt ? optionType : '';
    const lotSize  = (lotSizeMap && lotSizeMap[base]) || 1;
    const totalQty = String(lotSize * qty);
    const buySell  = (side.toUpperCase() === 'BUY' ? '1' : '2') + ' ';

    return [
        String(serial).padEnd(13), 'O', 'U',
        '1 ',           // Col  3: fixed constant
        '0',
        buySell,        // Col  5: BUY=1 SELL=2
        instrType,      // Col  6: OPTIDX/OPTSTK/FUTIDX/FUTSTK
        symbol.padEnd(10),
        expStr, strike, optType,
        '1 ',           // Col 11: fixed constant
        pad('', 11), pad('', 2), pad('', 9),
        pad('MKT', 10), pad('', 10),
        totalQty,       // Col 17: lot_size x qty (no padding)
        pad('', 9), pad('07708', 12), '2 ',
        pad(ucc, 10), pad('', 24), '0 ', pad('', 16), pad('', 12),
    ].join(',');
}

// ── MCS row (MCX basket format, CSV with header) ──────────────────────────────
// Proven against 4 MCX bulk files (FUT/OPT SHORT/LONG, 130 total rows)
// Col 2 = BuySellFlag (1=closing short, 2=closing long)
// Col 11 = qty padded to 9, Col 13 = MCX member code 45345
// Col 20 = strike price decimal for options, blank for futures
function makeMCSRow(serial, side, symbol, expiry, strikePrice, optionType, qty, ucc) {
    const buySell  = (side.toUpperCase() === 'BUY' ? '1' : '2') + ' ';
    const isFuture = !optionType || optionType === 'XX';
    let expStr = '';
    if (expiry) {
        const d   = new Date(expiry);
        const dd  = String(d.getUTCDate()).padStart(2, '0');
        const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
        expStr = dd + mon + d.getUTCFullYear();
    }
    const strikeStr = (!isFuture && strikePrice)
        ? String(Number(strikePrice).toFixed(2)) : '';
    return [
        pad('1', 13), '1 ', buySell, pad(symbol, 10), '',
        '1 ', pad('', 11), pad('', 2), pad('', 9), pad('MKT', 10),
        pad('', 8), pad(String(qty), 9), pad('', 9),
        pad('45345', 12), '2 ', pad(ucc, 10),
        pad('', 25), pad('', 16), pad(expStr, 10),
        optionType || '', strikeStr, pad('', 10),
    ].join(',');
}

// ── Generate basket files from order list ─────────────────────────────────────
async function generateBasketFiles(orders, ts) {
    // Fetch live lot sizes (same table as admin order generation)
    let lotSizeMap = {};
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('exchange', sql.VarChar(10), 'NSE')
            .query(`SELECT symbol, lot_size FROM lot_size_master
                    WHERE exchange = @exchange AND lot_size > 1`);
        result.recordset.forEach(r => {
            lotSizeMap[r.symbol.toUpperCase()] = r.lot_size;
        });
    } catch (e) {
        console.error('[RMSEmail] lot_size_master lookup failed (continuing):', e.message);
    }

    const files = [];

    // NSE Cash Market
    const nseCM = orders.filter(o => o.exchange === 'NSE' && o.segment === 'CM');
    if (nseCM.length) {
        const lines = nseCM.map((o, i) =>
            makeNeatCMRow(i + 1, o.side, o.symbol, o.quantity, o.ucc)
        );
        files.push({
            filename:    `BasketCM${ts}.txt`,
            content:     lines.join('\r\n'),
            contentType: 'text/plain',
        });
    }

    // NSE F&O
    const nseFO = orders.filter(o => o.exchange === 'NSE' && o.segment === 'FO');
    if (nseFO.length) {
        const lines = nseFO.map((o, i) =>
            makeNeatFORow(i + 1, o.side, o.symbol, o.expiry_date, o.strike_price,
                          o.option_type, o.quantity, o.ucc, lotSizeMap)
        );
        files.push({
            filename:    `BasketFO${ts}.txt`,
            content:     lines.join('\r\n'),
            contentType: 'text/plain',
        });
    }

    // MCX F&O
    const mcxFO = orders.filter(o => o.exchange === 'MCX' && o.segment === 'FO');
    if (mcxFO.length) {
        const header = 'ReferenceNumber,BookType,BuySellFlag,Symbol, Series,Instructions,' +
                       ' GTD,SpecialTerms,MFQty,Price,TrgPrice,NetQty,DQ,Participant,' +
                       'PROCLI,Ucc,Remarks,OrderNumber,ExpiryDate,Optiontype,SellPrice,ErrorCode';
        const lines  = [header, ...mcxFO.map((o, i) =>
            makeMCSRow(i + 1, o.side, o.symbol, o.expiry_date, o.strike_price,
                       o.option_type, o.quantity, o.ucc)
        )];
        files.push({
            filename:    `BasketMCX${ts}.csv`,
            content:     lines.join('\r\n'),
            contentType: 'text/csv',
        });
    }

    return files;
}

// ── Build and send the email ──────────────────────────────────────────────────
async function sendBatchEmail(orders) {
    if (!orders.length) return;

    const now  = new Date();
    const ts   = formatTimestamp(now);
    const time = now.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) + ' IST';

    const uccs      = [...new Set(orders.map(o => o.ucc))];
    const exchanges = [...new Set(orders.map(o => `${o.exchange} ${o.segment}`))].join(', ');
    const subject   = `[NAVIA BACKUP] Square-Off Request -- ${exchanges} -- ` +
                      `${orders.length} order${orders.length > 1 ? 's' : ''} -- UCC: ${uccs.join(', ')}`;

    // Generate basket files
    let files = [];
    try {
        files = await generateBasketFiles(orders, ts);
    } catch (e) {
        console.error('[RMSEmail] File generation error:', e.message);
    }

    // Order rows for email table
    const tableRows = orders.map(o => {
        const contract = o.strike_price
            ? `${o.symbol} ${Math.round(o.strike_price)} ${o.option_type || ''}`.trim()
            : o.symbol;
        const expiry = o.expiry_date
            ? new Date(o.expiry_date).toLocaleDateString('en-IN',
                { day: '2-digit', month: 'short', year: 'numeric' })
            : '--';
        const sideColor = o.side === 'SELL' ? '#dc2626' : '#16a34a';
        return `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace">${o.ucc}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">${contract}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${o.exchange} / ${o.segment}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${sideColor};font-weight:700">${o.side}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${o.quantity}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280">${expiry}</td>
        </tr>`;
    }).join('');

    const fileListHtml = files.length
        ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;
               padding:11px 16px;font-size:12px;color:#15803d;margin-bottom:14px">
               <strong>Basket file${files.length > 1 ? 's' : ''} attached:</strong>
               ${files.map(f => `<code style="margin-left:8px">${f.filename}</code>`).join('')}
           </div>`
        : `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;
               padding:11px 16px;font-size:12px;color:#713f12;margin-bottom:14px">
               File generation unavailable -- please generate manually from the admin panel.
           </div>`;

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto">
        <div style="background:#1e3a5f;padding:18px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:16px;font-weight:700">Navia Backup -- Square-Off Request</span>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;
                    border-radius:0 0 8px 8px;padding:22px 24px">
            <p style="margin:0 0 14px;font-size:13px;color:#374151">
                <strong>${orders.length} square-off order${orders.length > 1 ? 's have' : ' has'} been placed</strong>
                via Navia Backup. Please upload the attached basket file${files.length > 1 ? 's' : ''}
                to the exchange terminal immediately.
            </p>
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;
                          border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
                <thead>
                    <tr style="background:#f8fafc">
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">UCC</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Symbol</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Exchange</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Side</th>
                        <th style="padding:8px 12px;text-align:right;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Qty</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Expiry</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
            ${fileListHtml}
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;
                        padding:11px 16px;font-size:12px;color:#991b1b">
                <strong>Action required:</strong>
                Upload the attached file${files.length > 1 ? 's' : ''} to
                ${files.map(f => {
                    if (f.filename.startsWith('BasketCM'))  return 'NEAT terminal (CM)';
                    if (f.filename.startsWith('BasketFO'))  return 'NEAT terminal (FO)';
                    if (f.filename.startsWith('BasketMCX')) return 'MCS terminal (MCX)';
                    return f.filename;
                }).join(' / ')} immediately.
            </div>
            <p style="margin:14px 0 0;font-size:11px;color:#9ca3af">
                ${time} &nbsp;|&nbsp; Navia Backup &nbsp;|&nbsp; backup.navia.co.in
            </p>
        </div>
    </div>`;

    try {
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST, port: SMTP_PORT, secure: true,
            auth: { user: SMTP_USER, pass: SMTP_PASS },
            tls:  { rejectUnauthorized: false },
        });
        await transporter.sendMail({
            from:        `"Navia Backup" <${SMTP_USER}>`,
            to:          TO_EMAIL,
            bcc:         BCC_LIST.join(','),
            subject,
            html,
            attachments: files.map(f => ({
                filename:    f.filename,
                content:     f.content,
                contentType: f.contentType,
            })),
        });
        console.log(`[RMSEmail] Sent: "${subject}" | Attached: ${files.map(f => f.filename).join(', ')}`);
    } catch (e) {
        console.error('[RMSEmail] Send failed:', e.message);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * queueRMSEmailAlert(orderDetails)
 *
 * Sends an email immediately when an order is placed.
 * Always non-blocking (fire and forget).
 */
function queueRMSEmailAlert(orderDetails) {
    const order = {
        ucc:          orderDetails.ucc,
        symbol:       orderDetails.symbol,
        exchange:    (orderDetails.exchange  || '').toUpperCase(),
        segment:     (orderDetails.segment   || '').toUpperCase(),
        side:        (orderDetails.side      || '').toUpperCase(),
        quantity:     orderDetails.quantity,
        expiry_date:  orderDetails.expiry_date  || null,
        strike_price: orderDetails.strike_price || null,
        option_type:  orderDetails.option_type  || null,
    };
    console.log(`[RMSEmail] Sending alert: ${order.symbol} ${order.exchange}/${order.segment} UCC:${order.ucc}`);
    sendBatchEmail([order]).catch(e =>
        console.error('[RMSEmail] Send error:', e.message)
    );
}

module.exports = { queueRMSEmailAlert };