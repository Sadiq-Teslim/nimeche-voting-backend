// routes/nominations.js — Public nomination submission
const express = require('express')
const router = express.Router()
const { query } = require('../db')
const { nominateLimiter, getOrgId, getPortalMode } = require('./middleware')

function isValidImageUrl(value) {
    if (!value) return true
    if (typeof value !== 'string' || value.length > 500) return false
    try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
        return false
    }
}

router.post('/nominate', nominateLimiter, async (req, res) => {
    const { nominations } = req.body
    if (!Array.isArray(nominations) || nominations.length === 0 || nominations.length > 10) {
        return res.status(400).json({ message: 'Invalid nomination data.' })
    }
    // Validate each nomination
    for (const n of nominations) {
        if (!n.fullName || typeof n.fullName !== 'string' || n.fullName.length > 200) {
            return res.status(400).json({ message: 'Invalid nominee name.' })
        }
        if (!n.category || typeof n.category !== 'string' || n.category.length > 100) {
            return res.status(400).json({ message: 'Invalid category.' })
        }
        if (!isValidImageUrl(n.imageUrl)) {
            return res.status(400).json({ message: 'Invalid nominee image URL.' })
        }
    }
    try {
        const portalMode = await getPortalMode()
        if (portalMode !== 'nominations') {
            return res.status(403).json({ message: 'Nominations are currently closed.' })
        }

        const electionRes = await query(
            `select id from elections where organization_id = $1 order by created_at desc limit 1`,
            [getOrgId()]
        )
        const electionId = electionRes.rows[0]?.id || null
        if (!electionId) return res.status(400).json({ message: 'No election configured for nominations.' })

        const positionIds = [...new Set(nominations.map(n => n.category))]
        const positionRes = await query(
            `select id from positions where organization_id = $1 and election_id = $2 and id = any($3::text[])`,
            [getOrgId(), electionId, positionIds]
        )
        const validPositionIds = new Set(positionRes.rows.map(row => row.id))
        const invalidPosition = positionIds.find(id => !validPositionIds.has(id))
        if (invalidPosition) {
            return res.status(400).json({ message: 'One or more selected awards are no longer available.' })
        }

        for (const nomination of nominations) {
            await query(
                `insert into nominations (organization_id, election_id, full_name, popular_name, position_id, image_url)
                 values ($1, $2, $3, $4, $5, $6)`,
                [
                    getOrgId(),
                    electionId,
                    nomination.fullName.trim(),
                    nomination.popularName ? nomination.popularName.trim() : null,
                    nomination.category,
                    nomination.imageUrl || null,
                ]
            )
        }
        res.status(201).json({ success: true, message: 'Your nomination(s) have been submitted for review!' })
    } catch (error) {
        console.error('Error submitting nominations:', error)
        res.status(500).json({ message: 'A server error occurred while submitting.' })
    }
})

module.exports = router
