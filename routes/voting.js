// routes/voting.js — Voting endpoints (fingerprint + cookie based)
const express = require('express')
const router = express.Router()
const { query, transaction } = require('../db')
const { getOrgId, voteLimiter, csrfProtection, issueCsrfToken, votedCookieName, getElectionStatus, getPortalMode } = require('./middleware')

function isValidFingerprint(fingerprint) {
    return typeof fingerprint === 'string' && fingerprint.length >= 8 && fingerprint.length <= 64
}

function parseVotedCookie(req) {
    const votedCookie = req.cookies[votedCookieName()] || ''
    return votedCookie
        ? votedCookie.split(',').map(id => id.trim()).filter(Boolean)
        : []
}

function setVotedCookie(res, categoryIds) {
    const isProduction = process.env.NODE_ENV === 'production'
    res.cookie(votedCookieName(), [...new Set(categoryIds)].filter(Boolean).join(','), {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 365 * 24 * 60 * 60 * 1000,
        path: '/',
    })
}

async function getCurrentElectionId(orgId) {
    const electionRes = await query(
        `select id from elections where organization_id = $1 order by created_at desc limit 1`,
        [orgId]
    )
    return electionRes.rows[0]?.id || null
}

async function getDbVotedCategoryIds(orgId, electionId, fingerprint, categoryIds = []) {
    if (!isValidFingerprint(fingerprint) || !electionId) return []

    const params = [orgId, electionId, fingerprint]
    let categoryFilter = ''
    if (categoryIds.length > 0) {
        params.push(categoryIds)
        categoryFilter = `and position_id = any($4::text[])`
    }

    const result = await query(
        `select position_id
         from votes
         where organization_id = $1
           and election_id = $2
           and voter_fingerprint = $3
           ${categoryFilter}
         order by created_at asc`,
        params
    )
    return result.rows.map(row => row.position_id)
}

// Provide CSRF token
router.get('/csrf-token', (req, res) => {
    res.json({ csrfToken: issueCsrfToken(req, res) })
})

// Submit votes — immediate, no email verification
router.post('/submit-votes', voteLimiter, csrfProtection, async (req, res) => {
    const { fingerprint, department, choices } = req.body
    const orgId = getOrgId()

    // --- Input validation ---
    if (!isValidFingerprint(fingerprint)) {
        return res.status(400).json({ message: 'Invalid device fingerprint.' })
    }
    if (!Array.isArray(choices) || choices.length === 0 || choices.length > 60) {
        return res.status(400).json({ message: 'Invalid choices.' })
    }
    const normalizedChoices = []
    const seenCategoryIds = new Set()
    for (const c of choices) {
        if (!c.categoryId || typeof c.categoryId !== 'string' || c.categoryId.length > 100) {
            return res.status(400).json({ message: 'Invalid category in choices.' })
        }
        if (
            (!c.candidateId || typeof c.candidateId !== 'string' || c.candidateId.length > 80) &&
            (!c.nomineeName || typeof c.nomineeName !== 'string' || c.nomineeName.length > 200)
        ) {
            return res.status(400).json({ message: 'Invalid candidate in choices.' })
        }
        if (seenCategoryIds.has(c.categoryId)) continue
        seenCategoryIds.add(c.categoryId)
        normalizedChoices.push({
            categoryId: c.categoryId,
            candidateId: c.candidateId || null,
            nomineeName: c.nomineeName ? c.nomineeName.trim() : null,
        })
    }

    const status = await getElectionStatus()
    if (status !== 'open') {
        return res.status(403).json({ message: 'Voting is currently closed.' })
    }
    const portalMode = await getPortalMode()
    if (portalMode !== 'voting') {
        return res.status(403).json({ message: 'The portal is not currently accepting votes.' })
    }

    const cookieVotedIds = parseVotedCookie(req)

    try {
        const electionId = await getCurrentElectionId(orgId)
        if (!electionId) return res.status(400).json({ message: 'No active election configured.' })

        const departmentRes = await query(
            `select id from departments where organization_id = $1 and id = $2`,
            [orgId, department]
        )
        if (departmentRes.rowCount === 0) {
            return res.status(400).json({ message: 'Invalid department.' })
        }

        const selectedCategoryIds = normalizedChoices.map(choice => choice.categoryId)
        const dbVotedIds = await getDbVotedCategoryIds(orgId, electionId, fingerprint, selectedCategoryIds)
        const alreadyVotedIds = new Set([...cookieVotedIds, ...dbVotedIds])

        const recorded = await transaction(async client => {
            const inserted = []
            for (const { categoryId, candidateId: selectedCandidateId, nomineeName } of normalizedChoices) {
                if (alreadyVotedIds.has(categoryId)) continue

                const candidateParams = [orgId, electionId, categoryId]
                let candidateFilter = ''
                if (selectedCandidateId) {
                    candidateParams.push(selectedCandidateId)
                    candidateFilter = 'and id = $4'
                } else {
                    candidateParams.push(nomineeName)
                    candidateFilter = 'and name = $4'
                }

                const candidateRes = await client.query(
                    `select id from candidates
                     where organization_id = $1
                       and election_id = $2
                       and position_id = $3
                       and status = 'approved'
                       ${candidateFilter}
                     limit 1`,
                    candidateParams
                )
                const approvedCandidateId = candidateRes.rows[0]?.id
                if (!approvedCandidateId) continue

                const voteRes = await client.query(
                    `insert into votes (organization_id, election_id, voter_fingerprint, department_id, position_id, candidate_id)
                     values ($1, $2, $3, $4, $5, $6)
                     on conflict (election_id, voter_fingerprint, position_id) do nothing
                     returning position_id`,
                    [orgId, electionId, fingerprint, department, categoryId, approvedCandidateId]
                )
                if (voteRes.rowCount > 0) inserted.push(categoryId)
            }
            return inserted
        })

        const latestDbVotedIds = await getDbVotedCategoryIds(orgId, electionId, fingerprint, selectedCategoryIds)
        const allVotedIds = [...new Set([...cookieVotedIds, ...latestDbVotedIds, ...recorded])].filter(Boolean)
        setVotedCookie(res, allVotedIds)

        res.status(201).json({
            success: true,
            recorded,
            skipped: selectedCategoryIds.filter(categoryId => !recorded.includes(categoryId)),
            votedCategoryIds: allVotedIds,
        })
    } catch (error) {
        console.error('Error submitting votes:', error)
        res.status(500).json({ message: 'A server error occurred.' })
    }
})

// Get voted categories for this device. Cookie is fast, fingerprint-backed DB lookup is authoritative.
router.get('/voted-categories', async (req, res) => {
    const orgId = getOrgId()
    const cookieVotedIds = parseVotedCookie(req)
    const fingerprint = req.query.fingerprint

    try {
        const electionId = await getCurrentElectionId(orgId)
        const dbVotedIds = await getDbVotedCategoryIds(orgId, electionId, fingerprint)
        const ids = [...new Set([...cookieVotedIds, ...dbVotedIds])].filter(Boolean)
        if (ids.length > cookieVotedIds.length) setVotedCookie(res, ids)
        res.json({ votedCategoryIds: ids })
    } catch (error) {
        console.error('Error loading voted categories:', error)
        res.status(500).json({ message: 'Server error.' })
    }
})

// Validate department (landing page entry)
router.post('/validate', (req, res) => {
    const { department } = req.body
    query(
        `select id from departments where organization_id = $1 and id = $2`,
        [getOrgId(), department]
    )
        .then(result => {
            if (result.rowCount === 0) {
                return res.status(400).json({ valid: false, message: 'Invalid department.' })
            }
            res.json({ valid: true, departmentId: department })
        })
        .catch(error => {
            console.error('Error validating department:', error)
            res.status(500).json({ message: 'Server error.' })
        })
})

module.exports = router
