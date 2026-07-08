'use strict';
/**
 * rmsEmailAlert.js -- RMS Email Alert Service
 * ============================================
 * Sends a BATCHED email to the RMS/surveillance team when one or more
 * square-off orders are placed via Navia Backup.
 *
 * Uses a debounce window (2s, hard-capped at 8s) so that:
 *   - a single client placing multiple scrips/exchanges via Square Off All
 *     results in ONE email listing every order, and
 *   - multiple clients placing square-off requests around the same time
 *     also collapse into ONE email listing all of them,
 * instead of one email per order.
 *
 * The email is TABULAR ONLY -- no file is attached. RMS/technology must
 * log in to the Navia Backup Admin Panel to download/generate the actual
 * basket file for the orders listed in the email.
 *
 * Email:
 *   To:  surveillance@navia.co.in
 *   BCC: technology@navia.co.in, monicka@navia.co.in,
 *        kiruthika@navia.co.in, elamukil@navia.co.in
 */

const nodemailer = require('nodemailer');

// ── Email config ──────────────────────────────────────────────────────────────
const SMTP_HOST   = process.env.SMTP_HOST     || 'smtp.zatpatmail.com';
const SMTP_PORT   = 465;
const SMTP_USER   = process.env.SMTP_USER     || 'updates@navia.co.in';
const SMTP_PASS   = process.env.SMTP_PASSWORD;
const TO_EMAIL    = 'surveillance@navia.co.in';
const BCC_LIST    = [
    'technology@navia.co.in',
    'monicka@navia.co.in',
    'kiruthika@navia.co.in',
    'elamukil@navia.co.in',
];
const ADMIN_PANEL_URL = process.env.ADMIN_PANEL_URL || 'https://backup.navia.co.in/admin';

// ── Batching / debounce config ────────────────────────────────────────────────
const DEBOUNCE_MS = 2000;   // wait this long after the LAST order before sending
const MAX_WAIT_MS = 8000;   // ...but never delay the alert more than this total

let pendingOrders  = [];
let debounceTimer  = null;
let batchStartedAt = null;

// ── Build and send the batched email ──────────────────────────────────────────
async function sendBatchEmail(orders) {
    if (!orders.length) return;

    const now  = new Date();
    const time = now.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) + ' IST';

    const uccs      = [...new Set(orders.map(o => o.ucc))];
    const exchanges = [...new Set(orders.map(o => `${o.exchange} ${o.segment}`))].join(', ');
    const subject   = `[NAVIA BACKUP] Square-Off Request -- ${exchanges} -- ` +
                      `${orders.length} order${orders.length > 1 ? 's' : ''} -- UCC: ${uccs.join(', ')}`;

    // Order rows for the email table:
    // UCC | Exch + Seg | Symbol (Expiry Strike Type) | B/S | Qty
    const tableRows = orders.map(o => {
        const expiryStr = o.expiry_date
            ? new Date(o.expiry_date).toLocaleDateString('en-IN',
                { day: '2-digit', month: 'short', year: 'numeric' })
            : null;
        const details = [expiryStr, o.strike_price ? Math.round(o.strike_price) : null, o.option_type || null]
            .filter(Boolean).join(' ');
        const contract  = details ? `${o.symbol} (${details})` : o.symbol;
        const sideColor = o.side === 'SELL' ? '#dc2626' : '#16a34a';
        return `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace">${o.ucc}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${o.exchange} ${o.segment}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">${contract}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${sideColor};font-weight:700">${o.side}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${o.quantity}</td>
        </tr>`;
    }).join('');

    const downloadNoteHtml = `
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;
                    padding:11px 16px;font-size:12px;color:#1e3a8a">
            <strong>Action required:</strong> Log in to the
            <a href="${ADMIN_PANEL_URL}" style="color:#1d4ed8;font-weight:600">Navia Backup Admin Panel</a>
            and download the basket file for the order${orders.length > 1 ? 's' : ''} listed above,
            then upload it to the exchange terminal immediately.
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
                via Navia Backup. Details are listed below.
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
                                   border-bottom:2px solid #e5e7eb">Exch + Seg</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Symbol (Expiry Strike Type)</th>
                        <th style="padding:8px 12px;text-align:left;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">B/S</th>
                        <th style="padding:8px 12px;text-align:right;color:#6b7280;
                                   font-size:10px;text-transform:uppercase;letter-spacing:.05em;
                                   border-bottom:2px solid #e5e7eb">Qty</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
            ${downloadNoteHtml}
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
            from:    `"Navia Backup" <${SMTP_USER}>`,
            to:      TO_EMAIL,
            bcc:     BCC_LIST.join(','),
            subject,
            html,
        });
        console.log(`[RMSEmail] Sent: "${subject}" | ${orders.length} order(s), no attachment`);
    } catch (e) {
        console.error('[RMSEmail] Send failed:', e.message);
    }
}

// ── Debounce/flush logic ──────────────────────────────────────────────────────
function flushQueue() {
    const batch    = pendingOrders;
    pendingOrders  = [];
    debounceTimer  = null;
    batchStartedAt = null;

    if (batch.length) {
        sendBatchEmail(batch).catch(e =>
            console.error('[RMSEmail] Send error:', e.message)
        );
    }
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * queueRMSEmailAlert(orderDetails)
 *
 * Queues an order for the RMS alert email. Orders queued within DEBOUNCE_MS
 * of each other (whether from the same client's basket or from different
 * clients placing requests around the same time) are combined into a
 * single email, up to a maximum wait of MAX_WAIT_MS.
 *
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

    pendingOrders.push(order);
    if (!batchStartedAt) batchStartedAt = Date.now();

    console.log(`[RMSEmail] Queued: ${order.symbol} ${order.exchange}/${order.segment} ` +
                `UCC:${order.ucc} (batch size: ${pendingOrders.length})`);

    if (debounceTimer) clearTimeout(debounceTimer);

    const elapsed = Date.now() - batchStartedAt;
    const waitFor = elapsed >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;
    debounceTimer = setTimeout(flushQueue, waitFor);
}

module.exports = { queueRMSEmailAlert };