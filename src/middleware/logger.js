'use strict';
const fs   = require('fs');
const path = require('path');
const { getConnection, sql } = require('../config/database');

// ─── Log Categories ───────────────────────────────────────────────────────────
const LOG_TYPES = {
  // Auth
  CLIENT_LOGIN_ATTEMPT:   'CLIENT_LOGIN_ATTEMPT',
  CLIENT_LOGIN_SUCCESS:   'CLIENT_LOGIN_SUCCESS',
  CLIENT_LOGIN_FAILED:    'CLIENT_LOGIN_FAILED',
  CLIENT_OTP_SENT:        'CLIENT_OTP_SENT',
  CLIENT_OTP_VERIFIED:    'CLIENT_OTP_VERIFIED',
  CLIENT_OTP_FAILED:      'CLIENT_OTP_FAILED',
  CLIENT_LOGOUT:          'CLIENT_LOGOUT',

  ADMIN_LOGIN_ATTEMPT:    'ADMIN_LOGIN_ATTEMPT',
  ADMIN_LOGIN_SUCCESS:    'ADMIN_LOGIN_SUCCESS',
  ADMIN_LOGIN_FAILED:     'ADMIN_LOGIN_FAILED',
  ADMIN_OTP_SENT:         'ADMIN_OTP_SENT',
  ADMIN_OTP_VERIFIED:     'ADMIN_OTP_VERIFIED',

  DEALER_LOGIN_SUCCESS:   'DEALER_LOGIN_SUCCESS',
  DEALER_LOGIN_FAILED:    'DEALER_LOGIN_FAILED',
  DEALER_SSO_GENERATED:   'DEALER_SSO_GENERATED',
  DEALER_SSO_VALIDATED:   'DEALER_SSO_VALIDATED',
  DEALER_CREATED:         'DEALER_CREATED',

  // Client management
  CLIENT_CREATED:         'CLIENT_CREATED',
  CLIENT_UPDATED:         'CLIENT_UPDATED',
  CLIENT_BULK_UPLOAD:     'CLIENT_BULK_UPLOAD',
  CLIENT_DEACTIVATED:     'CLIENT_DEACTIVATED',

  // Orders
  SQUAREOFF_PLACED:       'SQUAREOFF_PLACED',
  SQUAREOFF_MARKED:       'SQUAREOFF_MARKED',
  ORDER_FILE_GENERATED:   'ORDER_FILE_GENERATED',

  // File uploads
  BF_FILE_UPLOADED:       'BF_FILE_UPLOADED',
  DAY_FILE_UPLOADED:      'DAY_FILE_UPLOADED',

  // Notifications
  OTP_SMS_SENT:           'OTP_SMS_SENT',
  OTP_EMAIL_SENT:         'OTP_EMAIL_SENT',
  ALERT_WHATSAPP_SENT:    'ALERT_WHATSAPP_SENT',
  ALERT_EMAIL_SENT:       'ALERT_EMAIL_SENT',

  // Admin actions
  SEGMENT_TOGGLED:        'SEGMENT_TOGGLED',
  ADMIN_CREATED:          'ADMIN_CREATED',
  ADMIN_UPDATED:          'ADMIN_UPDATED',

  // Security
  SECURITY_BLOCKED:       'SECURITY_BLOCKED',
  RATE_LIMIT_HIT:         'RATE_LIMIT_HIT',
  INVALID_API_KEY:        'INVALID_API_KEY',

  // System
  SYSTEM_ERROR:           'SYSTEM_ERROR',
  API_ERROR:              'API_ERROR',
};

// ─── Write to DB system_logs table ───────────────────────────────────────────
async function writeLog({ type, actor, actor_type, ucc, ip, details, status = 'SUCCESS', meta = null }) {
  try {
    const pool = await getConnection();
    await pool.request()
      .input('type',       sql.VarChar(100), type)
      .input('actor',      sql.VarChar(100), actor      || null)
      .input('actorType',  sql.VarChar(20),  actor_type || null)
      .input('ucc',        sql.VarChar(20),  ucc        || null)
      .input('ip',         sql.VarChar(50),  ip         || null)
      .input('details',    sql.VarChar(500), details    || null)
      .input('status',     sql.VarChar(20),  status)
      .input('meta',       sql.NVarChar(sql.MAX), meta ? JSON.stringify(meta) : null)
      .query(`
        INSERT INTO system_logs
          (log_type, actor, actor_type, ucc, ip_address, details, status, meta)
        VALUES
          (@type, @actor, @actorType, @ucc, @ip, @details, @status, @meta)
      `);
  } catch (err) {
    // Never crash app due to logging failure
    console.error('[Logger] DB write failed:', err.message);
  }
}

// ─── Helper to get IP from request ───────────────────────────────────────────
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
}

module.exports = { LOG_TYPES, writeLog, getIP };