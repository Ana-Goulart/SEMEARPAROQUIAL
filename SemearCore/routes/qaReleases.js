const express = require('express');
const { pool } = require('../database');
const { ensureTenantStructure } = require('../lib/tenantSetup');

const router = express.Router();

function requireAdmin(req, res, next) {
    if (!req.admin || !req.admin.id) return res.status(401).json({ error: 'Não autenticado.' });
    return next();
}

function calcularStatusMenu(funcionalidades) {
    if (!funcionalidades || !funcionalidades.length) return null;
    const statuses = funcionalidades.map((f) => f.status);
    if (statuses.every((s) => s === 'ok')) return 'ok';
    if (statuses.some((s) => s === 'falhou')) return 'falhou';
    if (statuses.some((s) => s !== 'nao_testado')) return 'parcial';
    return 'nao_testado';
}

router.get('/', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const [rows] = await pool.query(
            'SELECT id, versao, descricao, status, ambiente, created_at, updated_at FROM qa_releases ORDER BY created_at DESC'
        );
        return res.json(rows);
    } catch (err) {
        console.error('Erro ao listar qa_releases:', err);
        return res.status(500).json({ error: 'Erro ao carregar releases.' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const versao = String(req.body.versao || '').trim();
        const ambiente = String(req.body.ambiente || '').trim();
        if (!versao || !ambiente) return res.status(400).json({ error: 'Versão e ambiente são obrigatórios.' });
        if (!['homologacao', 'producao'].includes(ambiente)) return res.status(400).json({ error: 'Ambiente inválido.' });
        const descricao = String(req.body.descricao || '').trim();
        const [result] = await pool.query(
            'INSERT INTO qa_releases (versao, descricao, ambiente) VALUES (?, ?, ?)',
            [versao, descricao, ambiente]
        );
        return res.json({ id: result.insertId, message: 'Release criada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar qa_release:', err);
        return res.status(500).json({ error: 'Erro ao criar release.' });
    }
});

router.get('/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const releaseId = Number(req.params.id);

        const [[release]] = await pool.query(
            'SELECT id, versao, descricao, status, ambiente, created_at, updated_at FROM qa_releases WHERE id = ?',
            [releaseId]
        );
        if (!release) return res.status(404).json({ error: 'Release não encontrada.' });

        const [menus] = await pool.query(
            'SELECT id, nome, submenu_de, ordem FROM qa_menus WHERE ativo = 1 ORDER BY ordem ASC, nome ASC'
        );

        const [testes] = await pool.query(
            'SELECT menu_id, status, observacao FROM qa_testes WHERE release_id = ?',
            [releaseId]
        );
        const testesMap = {};
        for (const t of testes) testesMap[Number(t.menu_id)] = t;

        const menuIds = menus.map((m) => m.id);
        let funcionalidadesPorMenu = {};
        if (menuIds.length) {
            const placeholders = menuIds.map(() => '?').join(',');
            const [funcs] = await pool.query(
                `SELECT id, menu_id, descricao, ordem, created_at FROM qa_menu_funcionalidades WHERE menu_id IN (${placeholders}) AND ativo = 1 ORDER BY ordem ASC, id ASC`,
                menuIds
            );

            const funcIds = funcs.map((f) => f.id);
            let testesFuncMap = {};
            if (funcIds.length) {
                const fPlaceholders = funcIds.map(() => '?').join(',');
                const [testesFuncs] = await pool.query(
                    `SELECT funcionalidade_id, status, observacao, alterado, tipo_alteracao, descricao_alteracao FROM qa_testes_funcionalidades WHERE release_id = ? AND funcionalidade_id IN (${fPlaceholders})`,
                    [releaseId, ...funcIds]
                );
                for (const tf of testesFuncs) testesFuncMap[Number(tf.funcionalidade_id)] = tf;
            }

            for (const f of funcs) {
                const menuId = Number(f.menu_id);
                if (!funcionalidadesPorMenu[menuId]) funcionalidadesPorMenu[menuId] = [];
                const tf = testesFuncMap[f.id];
                funcionalidadesPorMenu[menuId].push({
                    funcionalidade_id: f.id,
                    descricao: f.descricao,
                    ordem: f.ordem,
                    created_at: f.created_at,
                    status: (tf && tf.status) || 'nao_testado',
                    observacao: (tf && tf.observacao) || '',
                    alterado: !!(tf && tf.alterado),
                    tipo_alteracao: (tf && tf.tipo_alteracao) || null,
                    descricao_alteracao: (tf && tf.descricao_alteracao) || ''
                });
            }
        }

        const checklist = menus.map((m) => {
            const teste = testesMap[m.id];
            const funcionalidades = funcionalidadesPorMenu[m.id] || [];
            const statusCalculado = funcionalidades.length ? calcularStatusMenu(funcionalidades) : (teste && teste.status) || 'nao_testado';
            return {
                menu_id: m.id,
                nome: m.nome,
                submenu_de: m.submenu_de,
                ordem: m.ordem,
                status: statusCalculado,
                observacao: (teste && teste.observacao) || '',
                funcionalidades
            };
        });

        return res.json({ release, checklist });
    } catch (err) {
        console.error('Erro ao carregar qa_release:', err);
        return res.status(500).json({ error: 'Erro ao carregar release.' });
    }
});

router.get('/:id/relatorio', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const releaseId = Number(req.params.id);

        const [[release]] = await pool.query(
            'SELECT id, versao, descricao, status, ambiente, created_at FROM qa_releases WHERE id = ?',
            [releaseId]
        );
        if (!release) return res.status(404).json({ error: 'Release não encontrada.' });

        const [funcionalidades] = await pool.query(
            `SELECT
                qm.nome AS menu_nome,
                qmf.descricao,
                qtf.tipo_alteracao,
                qtf.descricao_alteracao
             FROM qa_testes_funcionalidades qtf
             JOIN qa_menu_funcionalidades qmf ON qmf.id = qtf.funcionalidade_id
             JOIN qa_menus qm ON qm.id = qmf.menu_id
             WHERE qtf.release_id = ? AND qtf.alterado = 1
             ORDER BY qtf.tipo_alteracao, qm.nome, qmf.ordem, qmf.id`,
            [releaseId]
        );

        return res.json({ release, funcionalidades });
    } catch (err) {
        console.error('Erro ao carregar relatório da release:', err);
        return res.status(500).json({ error: 'Erro ao carregar relatório.' });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const releaseId = Number(req.params.id);
        const [[release]] = await pool.query('SELECT id, versao, ambiente FROM qa_releases WHERE id = ?', [releaseId]);
        if (!release) return res.status(404).json({ error: 'Release não encontrada.' });
        await pool.query('DELETE FROM qa_testes_funcionalidades WHERE release_id = ?', [releaseId]);
        await pool.query('DELETE FROM qa_testes WHERE release_id = ?', [releaseId]);
        await pool.query('DELETE FROM qa_releases WHERE id = ?', [releaseId]);
        return res.json({ message: `Release ${release.versao} excluída com sucesso.` });
    } catch (err) {
        console.error('Erro ao excluir qa_release:', err);
        return res.status(500).json({ error: 'Erro ao excluir release.' });
    }
});

router.patch('/:id/status', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const status = String(req.body.status || '').trim();
        if (!['aprovado', 'reprovado'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
        const [result] = await pool.query(
            'UPDATE qa_releases SET status = ? WHERE id = ?',
            [status, Number(req.params.id)]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Release não encontrada.' });
        return res.json({ message: 'Release finalizada com sucesso.' });
    } catch (err) {
        console.error('Erro ao finalizar qa_release:', err);
        return res.status(500).json({ error: 'Erro ao finalizar release.' });
    }
});

router.post('/:id/testes', requireAdmin, async (req, res) => {
    try {
        await ensureTenantStructure();
        const releaseId = Number(req.params.id);
        const testes = Array.isArray(req.body.testes) ? req.body.testes : [];
        if (!testes.length) return res.status(400).json({ error: 'Nenhum teste informado.' });

        const [[release]] = await pool.query('SELECT id FROM qa_releases WHERE id = ?', [releaseId]);
        if (!release) return res.status(404).json({ error: 'Release não encontrada.' });

        for (const t of testes) {
            const funcionalidades = Array.isArray(t.funcionalidades) ? t.funcionalidades : [];
            const statusMenu = funcionalidades.length ? calcularStatusMenu(funcionalidades) : (t.status || 'nao_testado');

            await pool.query(
                `INSERT INTO qa_testes (release_id, menu_id, status, observacao)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   status = VALUES(status),
                   observacao = VALUES(observacao)`,
                [
                    releaseId,
                    Number(t.menu_id),
                    statusMenu,
                    String(t.observacao || '').trim()
                ]
            );

            for (const f of funcionalidades) {
                await pool.query(
                    `INSERT INTO qa_testes_funcionalidades (release_id, funcionalidade_id, status, observacao, alterado, tipo_alteracao, descricao_alteracao)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       status = VALUES(status),
                       observacao = VALUES(observacao),
                       alterado = VALUES(alterado),
                       tipo_alteracao = VALUES(tipo_alteracao),
                       descricao_alteracao = VALUES(descricao_alteracao)`,
                    [
                        releaseId,
                        Number(f.funcionalidade_id),
                        f.status || 'nao_testado',
                        String(f.observacao || '').trim(),
                        f.alterado ? 1 : 0,
                        f.tipo_alteracao || null,
                        String(f.descricao_alteracao || '').trim()
                    ]
                );
            }
        }

        return res.json({ message: 'Checklist salvo com sucesso.' });
    } catch (err) {
        console.error('Erro ao salvar qa_testes:', err);
        return res.status(500).json({ error: 'Erro ao salvar checklist.' });
    }
});

module.exports = router;
