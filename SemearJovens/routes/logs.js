const express = require('express');
const { listLogs } = require('../lib/activityLogs');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        if (!req.user || !req.user.id || !req.user.tenant_id) {
            return res.status(401).json({ error: 'Não autenticado.' });
        }
        const rows = await listLogs(Number(req.user.tenant_id));
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar logs do SemearJovens:', err);
        return res.status(500).json({ error: 'Erro ao listar logs.' });
    }
});

module.exports = router;
