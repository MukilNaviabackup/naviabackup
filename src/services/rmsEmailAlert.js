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
 *   To: surveillance@navia.co.in, technology@navia.co.in, monicka@navia.co.in,
 *       kiruthika@navia.co.in, elamukil@navia.co.in
 *   (all recipients in direct To -- no BCC. The DropCopy sync alert emails from
 *   sync_dropcopy.py address every recipient directly in To and are received
 *   reliably; this RMS alert previously BCC'd everyone except surveillance@,
 *   and was NOT being received -- BCC'd mail where the visible To goes to a
 *   different address is treated more suspiciously by mail security filters.
 *   Switching to direct To for everyone matches the working pattern.)
 */

const nodemailer = require('nodemailer');

// ── Email config ──────────────────────────────────────────────────────────────
const SMTP_HOST   = process.env.SMTP_HOST     || 'smtp.zatpatmail.com';
const SMTP_PORT   = 465;
const SMTP_USER   = process.env.SMTP_USER     || 'updates@navia.co.in';
const SMTP_PASS   = process.env.SMTP_PASSWORD;
// FIX (2026-07-09, v9, ROOT CAUSE CONFIRMED): the diagnostic log revealed
// SMTP_USER resolves to the literal string "emailapikey" in this
// environment (an Azure App Service application setting), with a 144-char
// API-key-style SMTP_PASSWORD -- NOT the "updates@navia.co.in" mailbox
// account sync_dropcopy.py authenticates with. That's a legitimate,
// separate SMTP AUTH login for ZatpatMail's API-key auth mode -- but this
// file was also using SMTP_USER ("emailapikey") as the email's FROM
// address, which is not a valid email address at all. The App Service
// config has a DEDICATED `SMTP_FROM` setting for exactly this reason (auth
// identity and sending identity are two different things for this relay);
// this code just never read it. That mismatch -- authenticating fine, but
// sending with an invalid/unverified From -- is consistent with every piece
// of evidence so far: our logs show "250 accepted" (the login succeeds),
// yet the message never shows up in ZatpatMail's dashboard for the
// updates@navia.co.in account (because it was never sent AS that account).
const SMTP_FROM   = process.env.SMTP_FROM     || 'updates@navia.co.in';

// DIAGNOSTIC (kept from v7/v8): logs the actually-resolved config at startup
// (never the password itself, just whether it's set and its length) so any
// future "email not received" report can be checked against real evidence.
console.log(`[RMSEmail] DIAGNOSTIC -- resolved SMTP config: host="${SMTP_HOST}" port=${SMTP_PORT} user="${SMTP_USER}" from="${SMTP_FROM}" passSet=${!!SMTP_PASS} passLen=${SMTP_PASS ? SMTP_PASS.length : 0}`);

const TO_LIST     = [
    'surveillance@navia.co.in',
    'technology@navia.co.in',
    'monicka@navia.co.in',
    'kiruthika@navia.co.in',
    'elamukil@navia.co.in',
];

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

    // FIX (2026-07-08): removed the clickable <a href> link to the admin panel.
    // The DropCopy sync/staleness alert emails (sync_dropcopy.py) use the exact
    // same SMTP relay, port, and sender account as this RMS alert and are
    // received reliably -- ruling out a domain/relay authorization problem.
    // The one structural difference between the two is that this email
    // contained a clickable link; the DropCopy alert has none. A clickable
    // link in a message about financial square-off actions, sent via an
    // external relay, is a common trigger for anti-phishing/spam filtering
    // (e.g. Microsoft 365 Safe Links / EOP) even when SPF/DKIM pass -- and
    // this alert has gone undelivered (not even to Junk) for about a week.
    // Spelling out the URL as plain text (no <a> tag) matches the working
    // DropCopy alert's zero-link pattern exactly.
    const downloadNoteHtml = `
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;
                    padding:11px 16px;font-size:12px;color:#1e3a8a">
            <strong>Action required:</strong> Log in to the Navia Backup Admin Panel
            and download the basket file for the
            order${orders.length > 1 ? 's' : ''} listed above,
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
        // FIX (2026-07-09, v8): removed `tls: { rejectUnauthorized: false }`.
        // sync_dropcopy.py's smtplib.SMTP_SSL() call uses Python's DEFAULT SSL
        // context, which performs full certificate verification -- and it has
        // been delivering reliably. This code was explicitly disabling that
        // same verification. That is the one remaining real asymmetry between
        // the two code paths after content, headers, and Message-ID have all
        // been matched and still didn't fix delivery.
        // Why this matters: Node.js does NOT consult the Windows OS
        // certificate store by default (it ships its own bundled root CA
        // list) -- Python on Windows DOES read the OS store via
        // ssl.create_default_context(). If this server sits behind any
        // corporate network device that transparently inspects outbound TLS
        // (a security gateway, antivirus mail/web shield, DLP appliance --
        // common on corporate networks and totally invisible from inside the
        // app), and IT has installed that device's root certificate into
        // Windows' trust store, Python would silently trust it and pass
        // through untouched -- while Node would see an untrusted certificate
        // and throw, UNLESS verification was disabled, which is exactly what
        // `rejectUnauthorized:false` does. That would make Node's SMTP
        // session succeed against the inspecting device rather than
        // necessarily reaching ZatpatMail's real servers -- some such devices
        // complete the SMTP handshake themselves and apply their own content
        // rules (financial/trading-related text is a common DLP trigger)
        // before ever relaying onward, which fits everything observed: our
        // own logs show "250 accepted", yet ZatpatMail's own dashboard never
        // captures the message at all.
        // Removing the override restores full verification, matching
        // sync_dropcopy.py exactly. Two possible outcomes after deploying:
        //   (a) Sending still succeeds exactly as before -- rules this out,
        //       the certificate chain is fine, look elsewhere.
        //   (b) Sending now FAILS with a certificate error in the logs
        //       (look for e.code like UNABLE_TO_VERIFY_LEAF_SIGNATURE,
        //       SELF_SIGNED_CERT_IN_CHAIN, or CERT_HAS_EXPIRED) -- that
        //       PROVES a TLS-inspecting device sits on this path, which is
        //       the real root cause and needs your network/security team
        //       (allowlist this server's outbound 465 traffic, or add the
        //       inspecting device's root CA to this server via the
        //       NODE_EXTRA_CA_CERTS environment variable instead of
        //       disabling verification).
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST, port: SMTP_PORT, secure: true,
            auth: { user: SMTP_USER, pass: SMTP_PASS },
        });
        // FIX (2026-07-09): after a week of non-delivery even with the link
        // and admin-panel URL removed entirely (v5), the remaining problem is
        // not the content -- it's two structural differences from the
        // sync_dropcopy.py alert, which uses the SAME relay/port/account and
        // IS received reliably:
        //   1. Message-ID -- nodemailer was auto-generating one from the
        //      container's hostname, producing "@emailapikey" as the domain
        //      part instead of anything resembling navia.co.in. A Message-ID
        //      domain that doesn't match the sending domain at all is a
        //      signal some corporate mail filters (incl. Microsoft 365
        //      Defender) weigh when scoring a message. sync_dropcopy.py never
        //      hits this because it never sets Message-ID itself -- the relay
        //      assigns one. Explicitly setting a navia.co.in Message-ID here
        //      removes the mismatch either way.
        //   2. From header -- previously `"Navia Backup" <updates@navia.co.in>`
        //      (a display name attached to the address). sync_dropcopy.py
        //      sends from the plain address with no display name. Matching
        //      that exactly removes another difference from the known-good
        //      pattern.
        const info = await transporter.sendMail({
            from:      SMTP_FROM,
            to:        TO_LIST.join(','),
            subject,
            html,
            messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@navia.co.in>`,
        });
        // Mirror the delivery-confirmation logging already used by otpService.js --
        // a resolved sendMail() only proves our SMTP relay accepted the message,
        // NOT that the destination mailbox accepted it. Logging accepted/rejected/
        // response/messageId means a future "no email received" report can be
        // checked against real evidence instead of guessed at.
        console.log(`[RMSEmail] Sent: "${subject}" | ${orders.length} order(s), no attachment`);
        console.log(`[RMSEmail] Accepted: ${JSON.stringify(info.accepted)}`);
        console.log(`[RMSEmail] Rejected: ${JSON.stringify(info.rejected)}`);
        console.log(`[RMSEmail] Response: ${info.response}`);
        console.log(`[RMSEmail] Message-ID: ${info.messageId}`);
        if (info.rejected && info.rejected.length) {
            console.error(`[RMSEmail] WARNING -- relay rejected some recipients: ${JSON.stringify(info.rejected)}`);
        }
    } catch (e) {
        // v8: log e.code/e.command too -- for TLS failures these carry the
        // exact OpenSSL/Node TLS error name (e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE),
        // which is the single most useful piece of evidence for this investigation.
        console.error('[RMSEmail] Send failed:', e.message);
        console.error(`[RMSEmail] Error code: ${e.code || 'n/a'} | command: ${e.command || 'n/a'}`);
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