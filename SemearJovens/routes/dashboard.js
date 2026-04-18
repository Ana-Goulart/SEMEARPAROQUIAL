const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const router = express.Router();

function toMonth(value) {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > 12) return null;
    return num;
}

router.get('/aniversariantes', async (req, res) => {
    const mes = toMonth(req.query.mes);
    if (!mes) return res.status(400).json({ error: 'Mês inválido.' });

    try {
        const tenantId = getTenantId(req);

        const [jovens] = await pool.query(
            `SELECT
                id,
                nome_completo,
                telefone,
                email,
                data_nascimento,
                instagram,
                (YEAR(CURDATE()) - YEAR(data_nascimento)) AS idade_que_faz
             FROM jovens
             WHERE tenant_id = ?
               AND COALESCE(lista_mestre_ativo, 1) = 1
               AND data_nascimento IS NOT NULL
               AND MONTH(data_nascimento) = ?
             ORDER BY DAY(data_nascimento) ASC, nome_completo ASC`,
            [tenantId, mes]
        );

        const [tios] = await pool.query(
            `SELECT
                'Tio' AS tipo,
                nome_tio AS nome_completo,
                nome_tia AS conjuge,
                telefone_tio AS telefone,
                data_nascimento_tio AS data_nascimento,
                (YEAR(CURDATE()) - YEAR(data_nascimento_tio)) AS idade_que_faz
             FROM tios_casais
             WHERE tenant_id = ?
               AND COALESCE(origem_tipo, 'EJC') = 'EJC'
               AND data_nascimento_tio IS NOT NULL
               AND MONTH(data_nascimento_tio) = ?

             UNION ALL

            SELECT
                'Tia' AS tipo,
                nome_tia AS nome_completo,
                nome_tio AS conjuge,
                telefone_tia AS telefone,
                data_nascimento_tia AS data_nascimento,
                (YEAR(CURDATE()) - YEAR(data_nascimento_tia)) AS idade_que_faz
             FROM tios_casais
             WHERE tenant_id = ?
               AND COALESCE(origem_tipo, 'EJC') = 'EJC'
               AND data_nascimento_tia IS NOT NULL
               AND MONTH(data_nascimento_tia) = ?

             ORDER BY DAY(data_nascimento) ASC, nome_completo ASC`,
            [tenantId, mes, tenantId, mes]
        );

        return res.json({
            mes,
            jovens: Array.isArray(jovens) ? jovens : [],
            tios: Array.isArray(tios) ? tios : []
        });
    } catch (err) {
        console.error('Erro ao buscar aniversariantes:', err);
        return res.status(500).json({ error: 'Erro ao buscar aniversariantes.' });
    }
});

module.exports = router;
