const express = require('express');
const { listLogs } = require('../lib/activityLogs');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id || !req.admin.tenant_id) {
        return res.status(401).json({ error: 'Não autenticado.' });
    }
    return next();
}

router.get('/', requireAdmin, async (req, res) => {
    try {
        const rows = await listLogs(Number(req.admin.tenant_id));
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar logs do SemearAdmin:', err);
        return res.status(500).json({ error: 'Erro ao listar logs.' });
    }
});

module.exports = router;
