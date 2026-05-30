const express = require('express');
const { pool } = require('../database');

const router = express.Router();

router.get('/bairros', async (req, res) => {
    try {
        const uf = String(req.query.uf || '').trim().toUpperCase().slice(0, 2);
        const cidade = String(req.query.cidade || '').trim();
        if (!uf || !cidade) return res.json({ bairros: [] });

        const [rows] = await pool.query(
            `SELECT DISTINCT endereco_bairro AS bairro
             FROM jovens
             WHERE UPPER(TRIM(endereco_estado)) = ?
               AND UPPER(TRIM(endereco_cidade)) = UPPER(TRIM(?))
               AND endereco_bairro IS NOT NULL
               AND TRIM(endereco_bairro) <> ''
             ORDER BY endereco_bairro ASC
             LIMIT 200`,
            [uf, cidade]
        );
        return res.json({ bairros: (rows || []).map((row) => row.bairro).filter(Boolean) });
    } catch (err) {
        console.error('Erro ao listar bairros:', err);
        return res.status(500).json({ error: 'Erro ao listar bairros.' });
    }
});

router.get('/:cep', async (req, res) => {
    try {
        const cepRaw = String(req.params.cep || '');
        const cep = cepRaw.replace(/\D/g, '');
        if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido.' });

        const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.erro) {
            return res.status(404).json({ error: 'CEP não encontrado.' });
        }
        return res.json({
            cep: data.cep || cep,
            logradouro: data.logradouro || '',
            bairro: data.bairro || '',
            localidade: data.localidade || '',
            uf: data.uf || ''
        });
    } catch (err) {
        console.error('Erro ao buscar CEP:', err);
        return res.status(500).json({ error: 'Erro ao buscar CEP.' });
    }
});

module.exports = router;
