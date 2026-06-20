const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const router = express.Router();

// Rotas de resumo do dashboard.

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

async function listarTarefasDoUsuario(tenantId, usuarioId, tarefaId = null) {
    const params = [tenantId, usuarioId, tenantId, usuarioId];
    let filtroId = '';
    if (tarefaId) {
        filtroId = 'AND t.id = ?';
        params.push(tarefaId);
    }

    const [rows] = await pool.query(`
        SELECT
            t.id,
            t.ata_id,
            t.pauta_id,
            t.descricao,
            t.responsavel_usuario_id,
            t.responsavel_funcao_id,
            t.prazo,
            t.status,
            a.data_reuniao,
            a.horario,
            p.ordem AS pauta_ordem,
            p.titulo AS pauta_titulo,
            u.nome_completo AS responsavel_usuario_nome,
            fd.nome AS responsavel_funcao_nome,
            COALESCE(u.nome_completo, fd.nome) AS responsavel_nome,
            CASE
                WHEN t.responsavel_funcao_id IS NOT NULL THEN 'FUNCAO'
                WHEN t.responsavel_usuario_id IS NOT NULL THEN 'USUARIO'
                ELSE 'QUALQUER'
            END AS responsavel_tipo
        FROM ata_reuniao_tarefas t
        JOIN ata_reunioes a ON a.id = t.ata_id AND a.tenant_id = t.tenant_id
        LEFT JOIN ata_reuniao_pautas p ON p.id = t.pauta_id AND p.tenant_id = t.tenant_id
        LEFT JOIN usuarios u ON u.id = t.responsavel_usuario_id AND u.tenant_id = t.tenant_id
        LEFT JOIN funcoes_dirigencia fd ON fd.id = t.responsavel_funcao_id AND fd.tenant_id = t.tenant_id
        WHERE t.tenant_id = ?
          AND (
              t.responsavel_usuario_id = ?
              OR (
                  t.responsavel_funcao_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM funcoes_dirigencia_usuarios fdu
                      WHERE fdu.tenant_id = ?
                        AND fdu.usuario_id = ?
                        AND fdu.funcao_id = t.responsavel_funcao_id
                  )
              )
              OR (t.responsavel_usuario_id IS NULL AND t.responsavel_funcao_id IS NULL)
          )
          ${filtroId}
        ORDER BY
            CASE WHEN t.status = 'PENDENTE' THEN 0 ELSE 1 END ASC,
            (t.prazo IS NULL) ASC,
            t.prazo ASC,
            a.data_reuniao DESC,
            t.id DESC
    `, params);

    return rows;
}

router.get('/minhas-tarefas', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const usuarioId = Number(req.user && req.user.id);
        if (!tenantId || !usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });

        const rows = await listarTarefasDoUsuario(tenantId, usuarioId);
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar tarefas do dashboard:', err);
        return res.status(500).json({ error: 'Erro ao listar tarefas.' });
    }
});

router.put('/minhas-tarefas/:id/status', async (req, res) => {
    const tenantId = getTenantId(req);
    const usuarioId = Number(req.user && req.user.id);
    const tarefaId = Number(req.params.id);
    const status = String(req.body && req.body.status || '').trim().toUpperCase();

    if (!tenantId || !usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });
    if (!tarefaId) return res.status(400).json({ error: 'ID inválido.' });
    if (!['PENDENTE', 'CONCLUIDA'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
    }

    try {
        const tarefas = await listarTarefasDoUsuario(tenantId, usuarioId, tarefaId);
        if (!tarefas.length) return res.status(404).json({ error: 'Tarefa não encontrada para este usuário.' });

        const [result] = await pool.query(
            `UPDATE ata_reuniao_tarefas SET status = ? WHERE id = ? AND tenant_id = ?`,
            [status, tarefaId, tenantId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Tarefa não encontrada.' });

        return res.json({ id: tarefaId, status, message: 'Status da tarefa atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar tarefa do dashboard:', err);
        return res.status(500).json({ error: 'Erro ao atualizar tarefa.' });
    }
});

router.get('/minhas-tarefas/atas/:id', async (req, res) => {
    const tenantId = getTenantId(req);
    const usuarioId = Number(req.user && req.user.id);
    const ataId = Number(req.params.id);

    if (!tenantId || !usuarioId) return res.status(401).json({ error: 'Usuário não identificado.' });
    if (!ataId) return res.status(400).json({ error: 'ID inválido.' });

    try {
        const tarefasUsuario = await listarTarefasDoUsuario(tenantId, usuarioId);
        const podeVerAta = tarefasUsuario.some((tarefa) => Number(tarefa.ata_id) === ataId);
        if (!podeVerAta) return res.status(404).json({ error: 'Ata não encontrada para este usuário.' });

        const [atas] = await pool.query(
            `SELECT id, titulo, data_reuniao, horario, observacoes_gerais
             FROM ata_reunioes
             WHERE id = ? AND tenant_id = ?
             LIMIT 1`,
            [ataId, tenantId]
        );
        if (!atas.length) return res.status(404).json({ error: 'Ata não encontrada.' });

        const [presencas] = await pool.query(
            `SELECT ap.usuario_id, u.nome_completo
             FROM ata_reuniao_presencas ap
             JOIN usuarios u ON u.id = ap.usuario_id AND u.tenant_id = ap.tenant_id
             WHERE ap.ata_id = ? AND ap.tenant_id = ?
             ORDER BY u.nome_completo ASC`,
            [ataId, tenantId]
        );

        const [pautas] = await pool.query(
            `SELECT id, ordem, titulo, decisoes
             FROM ata_reuniao_pautas
             WHERE ata_id = ? AND tenant_id = ?
             ORDER BY ordem ASC, id ASC`,
            [ataId, tenantId]
        );

        const [tarefas] = await pool.query(
            `SELECT t.id, t.pauta_id, t.descricao, t.prazo, t.status,
                    COALESCE(u.nome_completo, fd.nome) AS responsavel_nome,
                    CASE
                        WHEN t.responsavel_funcao_id IS NOT NULL THEN 'FUNCAO'
                        WHEN t.responsavel_usuario_id IS NOT NULL THEN 'USUARIO'
                        ELSE 'QUALQUER'
                    END AS responsavel_tipo
             FROM ata_reuniao_tarefas t
             LEFT JOIN usuarios u ON u.id = t.responsavel_usuario_id AND u.tenant_id = t.tenant_id
             LEFT JOIN funcoes_dirigencia fd ON fd.id = t.responsavel_funcao_id AND fd.tenant_id = t.tenant_id
             WHERE t.ata_id = ? AND t.tenant_id = ?
             ORDER BY t.id ASC`,
            [ataId, tenantId]
        );

        const pautasPorId = {};
        const pautasComTarefas = pautas.map((pauta) => {
            const item = { ...pauta, tarefas: [] };
            pautasPorId[pauta.id] = item;
            return item;
        });
        tarefas.forEach((tarefa) => {
            if (tarefa.pauta_id && pautasPorId[tarefa.pauta_id]) {
                pautasPorId[tarefa.pauta_id].tarefas.push(tarefa);
            }
        });

        return res.json({
            ...atas[0],
            presencas,
            pautas: pautasComTarefas
        });
    } catch (err) {
        console.error('Erro ao carregar ata do dashboard:', err);
        return res.status(500).json({ error: 'Erro ao carregar ata.' });
    }
});

module.exports = router;
