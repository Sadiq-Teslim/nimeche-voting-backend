// routes/middleware.js — Shared middleware: rate limiters, CSRF, auth, election cache
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { query } = require('../db')

function getJwtSecret() {
    return process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'replace-this-secret'
}

function getOrgId() {
    return process.env.ORG_ID || 'default'
}

// =================================================================
// --- RATE LIMITERS ---
// =================================================================
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please slow down.' }
})

const voteLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many vote attempts. Please try again later.' }
})

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many admin requests.' }
})

const nominateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many nomination submissions. Try again later.' }
})

// =================================================================
// --- CSRF PROTECTION ---
// =================================================================
function csrfCookieName() {
    return `${getOrgId()}_csrf`
}

function votedCookieName() {
    return `${getOrgId()}_voted`
}

function issueCsrfToken(req, res) {
    const token = crypto.randomBytes(32).toString('hex')
    const isProduction = process.env.NODE_ENV === 'production'
    res.cookie(csrfCookieName(), token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 2 * 60 * 60 * 1000,
        path: '/',
    })
    return token
}

function csrfProtection(req, res, next) {
    const expectedToken = req.cookies[csrfCookieName()]
    const providedToken = req.get('X-CSRF-Token')
    if (!expectedToken || !providedToken || expectedToken !== providedToken) {
        return res.status(403).json({ message: 'Invalid security token. Please refresh and try again.' })
    }
    return next()
}

// =================================================================
// --- ADMIN AUTH MIDDLEWARE ---
// =================================================================
function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            jwt.verify(authHeader.slice(7), getJwtSecret())
            return next()
        } catch {
            return res.status(401).json({ message: 'Session expired. Please log in again.' })
        }
    }
    // Fallback: password in body (for backwards compatibility during migration)
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        return next()
    }
    return res.status(401).json({ message: 'Unauthorized: Invalid credentials.' })
}

// =================================================================
// --- ELECTION STATUS CACHE ---
// =================================================================
let electionStatusCache = { value: null, updatedAt: 0 }
let portalModeCache = { value: null, updatedAt: 0 }
const CACHE_TTL_MS = 10_000

async function getElectionStatus() {
    if (electionStatusCache.value && Date.now() - electionStatusCache.updatedAt < CACHE_TTL_MS) {
        return electionStatusCache.value
    }
    const result = await query(
        `select coalesce(
            (select value from settings where organization_id = $1 and key = 'electionStatus'),
            (select status from elections where organization_id = $1 order by created_at desc limit 1),
            'closed'
        ) as status`,
        [getOrgId()]
    )
    const status = result.rows[0]?.status || 'closed'
    electionStatusCache = { value: status, updatedAt: Date.now() }
    return status
}

async function getPortalMode() {
    if (portalModeCache.value && Date.now() - portalModeCache.updatedAt < CACHE_TTL_MS) {
        return portalModeCache.value
    }
    const result = await query(
        `select coalesce(
            (select value from settings where organization_id = $1 and key = 'portalMode'),
            'nominations'
        ) as mode`,
        [getOrgId()]
    )
    const mode = result.rows[0]?.mode || 'nominations'
    portalModeCache = { value: mode, updatedAt: Date.now() }
    return mode
}

function invalidateElectionCache() {
    electionStatusCache = { value: null, updatedAt: 0 }
    portalModeCache = { value: null, updatedAt: 0 }
}

module.exports = {
    getOrgId,
    globalLimiter,
    voteLimiter,
    adminLimiter,
    nominateLimiter,
    csrfProtection,
    issueCsrfToken,
    requireAdmin,
    getElectionStatus,
    getPortalMode,
    invalidateElectionCache,
    getJwtSecret,
    votedCookieName,
}
