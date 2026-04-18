const express = require('express');

const router = express.Router();

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
