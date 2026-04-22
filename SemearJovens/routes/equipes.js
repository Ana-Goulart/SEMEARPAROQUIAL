const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const {
    ensureHistoricoEquipesSnapshots,
    backfillHistoricoEquipesSnapshots
} = require('../lib/ejcHistorySnapshots');

const PAPEIS_PADRAO = ['Membro', 'Tio', 'Coordenador'];
let hasPapelBaseColumnCache = null;
let hasFuncoesPadraoTableCache = null;
let hasOrigemPadraoColumnCache = null;
let hasPapeisTableCache = null;
let hasIconeClasseColumnCache = null;
let hasCorIconeColumnCache = null;
let hasMembrosOutroEjcColumnCache = null;
let hasEquipeAtivaColumnCache = null;

async function hasPapelBaseColumn() {
    if (hasPapelBaseColumnCache !== null) return hasPapelBaseColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes_funcoes'
          AND COLUMN_NAME = 'papel_base'
    `);
    hasPapelBaseColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasPapelBaseColumnCache;
}

async function hasFuncoesPadraoTable() {
    if (hasFuncoesPadraoTableCache !== null) return hasFuncoesPadraoTableCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes_funcoes_padrao'
    `);
    hasFuncoesPadraoTableCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasFuncoesPadraoTableCache;
}

async function hasOrigemPadraoColumn() {
    if (hasOrigemPadraoColumnCache !== null) return hasOrigemPadraoColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes_funcoes'
          AND COLUMN_NAME = 'origem_padrao_id'
    `);
    hasOrigemPadraoColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasOrigemPadraoColumnCache;
}

async function hasPapeisTable() {
    if (hasPapeisTableCache !== null) return hasPapeisTableCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes_papeis'
    `);
    hasPapeisTableCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasPapeisTableCache;
}

async function hasIconeClasseColumn() {
    if (hasIconeClasseColumnCache !== null) return hasIconeClasseColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes'
          AND COLUMN_NAME = 'icone_classe'
    `);
    hasIconeClasseColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasIconeClasseColumnCache;
}

async function hasCorIconeColumn() {
    if (hasCorIconeColumnCache !== null) return hasCorIconeColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes'
          AND COLUMN_NAME = 'cor_icone'
    `);
    hasCorIconeColumnCache = !!(rows && rows[0] && rows[0].cnt > 0);
    return hasCorIconeColumnCache;
}

async function hasMembrosOutroEjcColumn() {
    if (hasMembrosOutroEjcColumnCache !== null) return hasMembrosOutroEjcColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes'
          AND COLUMN_NAME = 'membros_outro_ejc'
    `);
    const existe = !!(rows && rows[0] && rows[0].cnt > 0);
    if (!existe) {
        try {
            await pool.query('ALTER TABLE equipes ADD COLUMN membros_outro_ejc TINYINT(1) NOT NULL DEFAULT 0');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
    }
    hasMembrosOutroEjcColumnCache = true;
    return true;
}

async function hasEquipeAtivaColumn() {
    if (hasEquipeAtivaColumnCache !== null) return hasEquipeAtivaColumnCache;
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'equipes'
          AND COLUMN_NAME = 'ativa'
    `);
    const existe = !!(rows && rows[0] && rows[0].cnt > 0);
    if (!existe) {
        try {
            await pool.query('ALTER TABLE equipes ADD COLUMN ativa TINYINT(1) NOT NULL DEFAULT 1');
        } catch (e) {
            if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
        }
    }
    hasEquipeAtivaColumnCache = true;
    return true;
}

async function listarPapeisConfigurados(tenantId) {
    const tabelaExiste = await hasPapeisTable();
    if (!tabelaExiste) return PAPEIS_PADRAO.map((nome, i) => ({ id: i + 1, nome }));
    const [rows] = await pool.query('SELECT id, nome FROM equipes_papeis WHERE tenant_id = ? ORDER BY ordem ASC, nome ASC', [tenantId]);
    if (!rows || rows.length === 0) return PAPEIS_PADRAO.map((nome, i) => ({ id: i + 1, nome }));
    return rows;
}

async function normalizarPapelBase(papel, tenantId) {
    const valor = (papel || '').toString().trim();
    if (!valor) return 'Membro';
    const papeis = await listarPapeisConfigurados(tenantId);
    const match = papeis.find(p => (p.nome || '').toLowerCase() === valor.toLowerCase());
    return match ? match.nome : null;
}

async function aplicarFuncoesPadraoNaEquipe(equipeId, tenantId) {
    const tabelaPadraoExiste = await hasFuncoesPadraoTable();
    if (!tabelaPadraoExiste || !equipeId) return;

    const comPapelBase = await hasPapelBaseColumn();
    const comOrigemPadrao = await hasOrigemPadraoColumn();
    const [padroes] = await pool.query('SELECT id, nome, papel_base FROM equipes_funcoes_padrao WHERE tenant_id = ? ORDER BY id ASC', [tenantId]);
    for (const p of padroes) {
        const [exists] = comOrigemPadrao
            ? await pool.query(
                'SELECT id FROM equipes_funcoes WHERE tenant_id = ? AND equipe_id = ? AND origem_padrao_id = ? LIMIT 1',
                [tenantId, equipeId, p.id]
            )
            : await pool.query(
                comPapelBase
                    ? 'SELECT id FROM equipes_funcoes WHERE tenant_id = ? AND equipe_id = ? AND nome = ? AND COALESCE(papel_base, "Membro") = ? LIMIT 1'
                    : 'SELECT id FROM equipes_funcoes WHERE tenant_id = ? AND equipe_id = ? AND nome = ? LIMIT 1',
                comPapelBase ? [tenantId, equipeId, p.nome, p.papel_base || 'Membro'] : [tenantId, equipeId, p.nome]
            );

        if (exists.length > 0) continue;

        if (comOrigemPadrao && comPapelBase) {
            await pool.query(
                'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base, origem_padrao_id) VALUES (?, ?, ?, ?, ?)',
                [tenantId, equipeId, p.nome, p.papel_base || 'Membro', p.id]
            );
        } else if (comPapelBase) {
            await pool.query(
                'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base) VALUES (?, ?, ?, ?)',
                [tenantId, equipeId, p.nome, p.papel_base || 'Membro']
            );
        } else {
            await pool.query(
                'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome) VALUES (?, ?, ?)',
                [tenantId, equipeId, p.nome]
            );
        }
    }
}

async function vincularTodasEquipesSeEjcSemVinculo(ejcId, tenantId) {
    const tenantIdNumero = Number(tenantId || 0);
    const ejcIdNumero = Number(ejcId);
    if (!Number.isInteger(ejcIdNumero) || ejcIdNumero <= 0) return;

    const [ejcRows] = await pool.query('SELECT id FROM ejc WHERE id = ? AND tenant_id = ? LIMIT 1', [ejcIdNumero, tenantIdNumero]);
    if (!ejcRows || ejcRows.length === 0) return;

    const [countRows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM equipes_ejc WHERE ejc_id = ? AND tenant_id = ?',
        [ejcIdNumero, tenantIdNumero]
    );
    if (countRows && countRows[0] && Number(countRows[0].cnt) > 0) return;

    await hasEquipeAtivaColumn();
    await pool.query(
        `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
         SELECT ?, ?, id
         FROM equipes
         WHERE tenant_id = ?
           AND COALESCE(ativa, 1) = 1`,
        [tenantIdNumero, ejcIdNumero, tenantIdNumero]
    );
}

// GET - Listar todas as equipes
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await hasEquipeAtivaColumn();
        const comMembrosOutroEjc = await hasMembrosOutroEjcColumn();
        const [rows] = await pool.query(
            comMembrosOutroEjc
                ? 'SELECT * FROM equipes WHERE tenant_id = ? AND COALESCE(ativa, 1) = 1 ORDER BY nome ASC'
                : 'SELECT id, nome, descricao, created_at FROM equipes WHERE tenant_id = ? AND COALESCE(ativa, 1) = 1 ORDER BY nome ASC',
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar todas as equipes:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// GET - Equipes por EJC (para dropdowns ou filtro no frontend)
router.get('/por-ejc/:ejcId', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureHistoricoEquipesSnapshots();
        await backfillHistoricoEquipesSnapshots({ tenantId, ejcId: req.params.ejcId });
        await vincularTodasEquipesSeEjcSemVinculo(req.params.ejcId, tenantId);
        // Corrige vínculos legados criados com tenant_id = 0.
        await pool.query(`
            UPDATE equipes_ejc ee
            JOIN ejc e ON e.id = ee.ejc_id
            JOIN equipes eq ON eq.id = ee.equipe_id
            SET ee.tenant_id = e.tenant_id
            WHERE ee.ejc_id = ?
              AND ee.tenant_id = 0
              AND e.tenant_id = ?
              AND eq.tenant_id = ?
        `, [req.params.ejcId, tenantId, tenantId]);
        const [rows] = await pool.query(`
            SELECT id, nome, descricao
            FROM (
                SELECT DISTINCT
                    eq.id,
                    eq.nome,
                    eq.descricao
                FROM equipes eq
                JOIN equipes_ejc ee
                  ON eq.id = ee.equipe_id
                 AND ee.tenant_id = eq.tenant_id
                WHERE ee.ejc_id = ?
                  AND ee.tenant_id = ?

                UNION

                SELECT DISTINCT
                    MIN(eq2.id) AS id,
                    he.equipe AS nome,
                    COALESCE(MIN(eq2.descricao), 'Equipe preservada no histórico do EJC') AS descricao
                FROM historico_equipes he
                LEFT JOIN equipes eq2
                  ON eq2.nome = he.equipe
                 AND eq2.tenant_id = he.tenant_id
                WHERE he.ejc_id = ?
                  AND he.tenant_id = ?
                  AND COALESCE(he.equipe, '') <> ''
                GROUP BY he.equipe
            ) equipes_base
            ORDER BY nome ASC
        `, [req.params.ejcId, tenantId, req.params.ejcId, tenantId]);
        res.json(rows.map((row, idx) => ({
            id: row.id || encodeURIComponent(String(row.nome || '').trim()) || `historico-${idx}`,
            nome: row.nome,
            descricao: row.descricao
        })));
    } catch (err) {
        console.error("Erro ao buscar equipes:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// GET - Listar papéis base disponíveis (ex.: Membro, Tio, Coordenador)
router.get('/papeis', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const papeis = await listarPapeisConfigurados(tenantId);
        res.json(papeis);
    } catch (err) {
        console.error("Erro ao listar papéis:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// POST - Criar novo papel base
router.post('/papeis', async (req, res) => {
    const nome = (req.body.nome || '').toString().trim();
    if (!nome) return res.status(400).json({ error: "Nome do papel é obrigatório" });

    try {
        const tenantId = getTenantId(req);
        const tabelaExiste = await hasPapeisTable();
        if (!tabelaExiste) {
            return res.status(500).json({ error: "Tabela de papéis não encontrada. Rode a migração." });
        }

        const [exists] = await pool.query(
            'SELECT id FROM equipes_papeis WHERE tenant_id = ? AND LOWER(nome) = LOWER(?) LIMIT 1',
            [tenantId, nome]
        );
        if (exists.length > 0) {
            return res.status(409).json({ error: "Esse papel já existe." });
        }

        const [maxRows] = await pool.query('SELECT COALESCE(MAX(ordem), 0) AS max_ordem FROM equipes_papeis WHERE tenant_id = ?', [tenantId]);
        const ordem = (maxRows && maxRows[0] && maxRows[0].max_ordem ? Number(maxRows[0].max_ordem) : 0) + 1;
        const [result] = await pool.query(
            'INSERT INTO equipes_papeis (tenant_id, nome, ordem) VALUES (?, ?, ?)',
            [tenantId, nome, ordem]
        );

        res.json({ id: result.insertId, message: "Papel criado com sucesso" });
    } catch (err) {
        console.error("Erro ao criar papel:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// DELETE - Excluir papel base
router.delete('/papeis/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const tabelaExiste = await hasPapeisTable();
        if (!tabelaExiste) {
            return res.status(404).json({ error: "Papéis não configurados no banco." });
        }

        const [rows] = await pool.query('SELECT id, nome FROM equipes_papeis WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        if (rows.length === 0) return res.status(404).json({ error: "Papel não encontrado" });
        const papel = rows[0];

        const [qtdRows] = await pool.query('SELECT COUNT(*) AS cnt FROM equipes_papeis WHERE tenant_id = ?', [tenantId]);
        if ((qtdRows && qtdRows[0] && qtdRows[0].cnt <= 1)) {
            return res.status(409).json({ error: "É necessário manter ao menos 1 papel cadastrado." });
        }

        const [usoFuncoes] = await pool.query(
            'SELECT COUNT(*) AS cnt FROM equipes_funcoes WHERE tenant_id = ? AND COALESCE(papel_base, "Membro") = ?',
            [tenantId, papel.nome]
        );
        if (usoFuncoes && usoFuncoes[0] && usoFuncoes[0].cnt > 0) {
            return res.status(409).json({ error: "Não é possível excluir: papel em uso nas funções das equipes." });
        }

        const tabelaPadraoExiste = await hasFuncoesPadraoTable();
        if (tabelaPadraoExiste) {
            const [usoPadrao] = await pool.query(
                'SELECT COUNT(*) AS cnt FROM equipes_funcoes_padrao WHERE tenant_id = ? AND COALESCE(papel_base, "Membro") = ?',
                [tenantId, papel.nome]
            );
            if (usoPadrao && usoPadrao[0] && usoPadrao[0].cnt > 0) {
                return res.status(409).json({ error: "Não é possível excluir: papel em uso nas funções padrão." });
            }
        }

        await pool.query('DELETE FROM equipes_papeis WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        res.json({ message: "Papel removido com sucesso" });
    } catch (err) {
        console.error("Erro ao remover papel:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// POST - Criar equipe
router.post('/', async (req, res) => {
    const { nome, descricao, ejc_id, icone_classe, cor_icone, membros_outro_ejc } = req.body;

    if (!nome) {
        return res.status(400).json({ error: "Nome da equipe é obrigatório" });
    }

    try {
        const tenantId = getTenantId(req);
        await hasEquipeAtivaColumn();
        const [checkEquipe] = await pool.query(
            'SELECT id, COALESCE(ativa, 1) AS ativa FROM equipes WHERE tenant_id = ? AND nome = ? LIMIT 1',
            [tenantId, nome]
        );

        let equipeId;
        let equipeCriada = false;
        if (checkEquipe.length > 0) {
            equipeId = checkEquipe[0].id;
            if (Number(checkEquipe[0].ativa || 0) !== 1) {
                const comIconeClasse = await hasIconeClasseColumn();
                const comCorIcone = await hasCorIconeColumn();
                const comMembrosOutroEjc = await hasMembrosOutroEjcColumn();
                if (comIconeClasse && comCorIcone && comMembrosOutroEjc) {
                    await pool.query(
                        'UPDATE equipes SET nome = ?, descricao = ?, icone_classe = ?, cor_icone = ?, membros_outro_ejc = ?, ativa = 1 WHERE id = ? AND tenant_id = ?',
                        [nome, descricao || null, icone_classe || null, cor_icone || '#2563eb', membros_outro_ejc ? 1 : 0, equipeId, tenantId]
                    );
                } else {
                    await pool.query(
                        'UPDATE equipes SET nome = ?, descricao = ?, ativa = 1 WHERE id = ? AND tenant_id = ?',
                        [nome, descricao || null, equipeId, tenantId]
                    );
                }
            }
        } else {
            const comIconeClasse = await hasIconeClasseColumn();
            const comCorIcone = await hasCorIconeColumn();
            const comMembrosOutroEjc = await hasMembrosOutroEjcColumn();
            const [createResult] = (comIconeClasse && comCorIcone && comMembrosOutroEjc)
                ? await pool.query(
                    'INSERT INTO equipes (tenant_id, nome, descricao, icone_classe, cor_icone, membros_outro_ejc) VALUES (?, ?, ?, ?, ?, ?)',
                    [tenantId, nome, descricao || null, icone_classe || null, cor_icone || '#2563eb', membros_outro_ejc ? 1 : 0]
                )
                : await pool.query(
                    'INSERT INTO equipes (tenant_id, nome, descricao) VALUES (?, ?, ?)',
                    [tenantId, nome, descricao || null]
                );
            equipeId = createResult.insertId;
            equipeCriada = true;
        }

        if (equipeCriada) {
            await aplicarFuncoesPadraoNaEquipe(equipeId, tenantId);
        }

        if (ejc_id) {
            const [checkVinculo] = await pool.query(
                'SELECT id FROM equipes_ejc WHERE tenant_id = ? AND ejc_id = ? AND equipe_id = ?',
                [tenantId, ejc_id, equipeId]
            );

            if (checkVinculo.length === 0) {
                await pool.query(
                    'INSERT INTO equipes_ejc (tenant_id, ejc_id, equipe_id) VALUES (?, ?, ?)',
                    [tenantId, ejc_id, equipeId]
                );
            }
        } else {
            // Sem EJC informado: equipe global, vincular em todos os EJCs existentes.
            await pool.query(
                `INSERT IGNORE INTO equipes_ejc (tenant_id, ejc_id, equipe_id)
                 SELECT ?, e.id, ?
                 FROM ejc e
                 WHERE e.tenant_id = ?`,
                [tenantId, equipeId, tenantId]
            );
        }

        res.json({ id: equipeId, message: "Equipe criada/vinculada com sucesso" });
    } catch (err) {
        console.error("Erro ao criar equipe:", err);
        res.status(500).json({ error: "Erro ao criar equipe" });
    }
});

// PUT - Atualizar equipe
router.put('/:id', async (req, res) => {
    const { nome, descricao, icone_classe, cor_icone, membros_outro_ejc } = req.body;
    const { id } = req.params;

    if (!nome) {
        return res.status(400).json({ error: "Nome da equipe é obrigatório" });
    }

    try {
        const tenantId = getTenantId(req);
        await hasEquipeAtivaColumn();
        const comIconeClasse = await hasIconeClasseColumn();
        const comCorIcone = await hasCorIconeColumn();
        const comMembrosOutroEjc = await hasMembrosOutroEjcColumn();
        const [result] = (comIconeClasse && comCorIcone && comMembrosOutroEjc)
            ? await pool.query(
                'UPDATE equipes SET nome = ?, descricao = ?, icone_classe = ?, cor_icone = ?, membros_outro_ejc = ?, ativa = 1 WHERE id = ? AND tenant_id = ?',
                [nome, descricao || null, icone_classe || null, cor_icone || '#2563eb', membros_outro_ejc ? 1 : 0, id, tenantId]
            )
            : await pool.query(
                'UPDATE equipes SET nome = ?, descricao = ?, ativa = 1 WHERE id = ? AND tenant_id = ?',
                [nome, descricao || null, id, tenantId]
            );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Equipe não encontrada" });
        }

        res.json({ message: "Equipe atualizada com sucesso" });
    } catch (err) {
        console.error("Erro ao atualizar equipe:", err);
        res.status(500).json({ error: "Erro ao atualizar equipe" });
    }
});

// DELETE - Remover vínculo com EJC
router.delete('/vinculo/:ejcId/:equipeId', async (req, res) => {
    const { ejcId, equipeId } = req.params;
    try {
        const tenantId = getTenantId(req);
        const [result] = await pool.query(
            'DELETE FROM equipes_ejc WHERE ejc_id = ? AND equipe_id = ? AND tenant_id = ?',
            [ejcId, equipeId, tenantId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Vínculo não encontrado" });
        }
        res.json({ message: "Equipe removida do EJC com sucesso" });
    } catch (err) {
        console.error("Erro ao remover equipe:", err);
        res.status(500).json({ error: "Erro ao remover equipe" });
    }
});

// DELETE - Arquivar equipe preservando vínculos já existentes
router.delete('/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await hasEquipeAtivaColumn();
        const [result] = await pool.query(
            'UPDATE equipes SET ativa = 0 WHERE id = ? AND tenant_id = ?',
            [req.params.id, tenantId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Equipe não encontrada" });
        }
        res.json({ message: "Equipe removida do menu e preservada nas edições já vinculadas." });
    } catch (err) {
        console.error("Erro ao deletar equipe:", err);
        res.status(500).json({ error: "Erro ao deletar equipe" });
    }
});

// --- FUNÇÕES DA EQUIPE ---

// GET - Listar funções padrão globais
router.get('/funcoes-padrao', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const tabelaPadraoExiste = await hasFuncoesPadraoTable();
        if (!tabelaPadraoExiste) return res.json([]);
        const [rows] = await pool.query(`
            SELECT id, nome, COALESCE(papel_base, 'Membro') AS papel_base, created_at
            FROM equipes_funcoes_padrao
            WHERE tenant_id = ?
            ORDER BY nome ASC
        `, [tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao listar funções padrão:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// POST - Criar função padrão global e aplicar a todas as equipes
router.post('/funcoes-padrao', async (req, res) => {
    const { nome, papel_base } = req.body;
    const nomeNormalizado = (nome || '').toString().trim();
    if (!nomeNormalizado) return res.status(400).json({ error: "Nome da função padrão é obrigatório" });

    const tenantId = getTenantId(req);
    const papelBaseNormalizado = await normalizarPapelBase(papel_base, tenantId);
    if (!papelBaseNormalizado) {
        return res.status(400).json({ error: "Papel base inválido. Cadastre o papel desejado em 'Papéis' no menu Equipes." });
    }

    try {
        const tabelaPadraoExiste = await hasFuncoesPadraoTable();
        if (!tabelaPadraoExiste) {
            return res.status(500).json({ error: "Tabela de funções padrão não encontrada. Rode a migração." });
        }

        const [existsPadrao] = await pool.query(
            'SELECT id FROM equipes_funcoes_padrao WHERE tenant_id = ? AND nome = ? AND COALESCE(papel_base, "Membro") = ? LIMIT 1',
            [tenantId, nomeNormalizado, papelBaseNormalizado]
        );
        if (existsPadrao.length > 0) {
            return res.status(409).json({ error: "Essa função padrão já existe para este papel." });
        }

        const [result] = await pool.query(
            'INSERT INTO equipes_funcoes_padrao (tenant_id, nome, papel_base) VALUES (?, ?, ?)',
            [tenantId, nomeNormalizado, papelBaseNormalizado]
        );

        const [equipesRows] = await pool.query('SELECT id FROM equipes WHERE tenant_id = ?', [tenantId]);
        for (const eq of equipesRows) {
            await aplicarFuncoesPadraoNaEquipe(eq.id, tenantId);
        }

        res.json({ id: result.insertId, message: "Função padrão criada e aplicada às equipes" });
    } catch (err) {
        console.error("Erro ao criar função padrão:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// DELETE - Remover função padrão global e remover vínculos das equipes
router.delete('/funcoes-padrao/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const tabelaPadraoExiste = await hasFuncoesPadraoTable();
        if (!tabelaPadraoExiste) {
            return res.status(404).json({ error: "Funções padrão não configuradas no banco." });
        }

        const [rows] = await pool.query(
            'SELECT id, nome, COALESCE(papel_base, "Membro") AS papel_base FROM equipes_funcoes_padrao WHERE id = ? AND tenant_id = ?',
            [req.params.id, tenantId]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Função padrão não encontrada" });
        const padrao = rows[0];

        const comOrigemPadrao = await hasOrigemPadraoColumn();
        const comPapelBase = await hasPapelBaseColumn();
        if (comOrigemPadrao) {
            await pool.query('DELETE FROM equipes_funcoes WHERE origem_padrao_id = ? AND tenant_id = ?', [padrao.id, tenantId]);
        } else {
            await pool.query(
                comPapelBase
                    ? 'DELETE FROM equipes_funcoes WHERE tenant_id = ? AND nome = ? AND COALESCE(papel_base, "Membro") = ?'
                    : 'DELETE FROM equipes_funcoes WHERE tenant_id = ? AND nome = ?',
                comPapelBase ? [tenantId, padrao.nome, padrao.papel_base] : [tenantId, padrao.nome]
            );
        }

        await pool.query('DELETE FROM equipes_funcoes_padrao WHERE id = ? AND tenant_id = ?', [padrao.id, tenantId]);
        res.json({ message: "Função padrão removida com sucesso" });
    } catch (err) {
        console.error("Erro ao remover função padrão:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// GET - Listar funções de uma equipe
router.get('/:id/funcoes', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const comPapelBase = await hasPapelBaseColumn();
        const comOrigemPadrao = await hasOrigemPadraoColumn();
        const sql = comPapelBase
            ? (comOrigemPadrao
                ? 'SELECT id, equipe_id, nome, COALESCE(papel_base, "Membro") AS papel_base, origem_padrao_id, CASE WHEN origem_padrao_id IS NULL THEN 0 ELSE 1 END AS is_padrao FROM equipes_funcoes WHERE equipe_id = ? AND tenant_id = ? ORDER BY nome ASC'
                : 'SELECT id, equipe_id, nome, COALESCE(papel_base, "Membro") AS papel_base, NULL AS origem_padrao_id, 0 AS is_padrao FROM equipes_funcoes WHERE equipe_id = ? AND tenant_id = ? ORDER BY nome ASC')
            : (comOrigemPadrao
                ? 'SELECT id, equipe_id, nome, "Membro" AS papel_base, origem_padrao_id, CASE WHEN origem_padrao_id IS NULL THEN 0 ELSE 1 END AS is_padrao FROM equipes_funcoes WHERE equipe_id = ? AND tenant_id = ? ORDER BY nome ASC'
                : 'SELECT id, equipe_id, nome, "Membro" AS papel_base, NULL AS origem_padrao_id, 0 AS is_padrao FROM equipes_funcoes WHERE equipe_id = ? AND tenant_id = ? ORDER BY nome ASC');
        const [rows] = await pool.query(sql, [req.params.id, tenantId]);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar funções:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// POST - Criar função para uma equipe
router.post('/:id/funcoes', async (req, res) => {
    const { nome, papel_base } = req.body;
    if (!nome) return res.status(400).json({ error: "Nome da função é obrigatório" });
    const tenantId = getTenantId(req);
    const papelBaseNormalizado = await normalizarPapelBase(papel_base, tenantId);
    if (!papelBaseNormalizado) {
        return res.status(400).json({ error: "Papel base inválido. Cadastre o papel desejado em 'Papéis' no menu Equipes." });
    }

    try {
        const comPapelBase = await hasPapelBaseColumn();
        const comOrigemPadrao = await hasOrigemPadraoColumn();
        const [result] = comPapelBase
            ? (comOrigemPadrao
                ? await pool.query(
                    'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base, origem_padrao_id) VALUES (?, ?, ?, ?, NULL)',
                    [tenantId, req.params.id, nome, papelBaseNormalizado]
                )
                : await pool.query(
                    'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome, papel_base) VALUES (?, ?, ?, ?)',
                    [tenantId, req.params.id, nome, papelBaseNormalizado]
                ))
            : await pool.query(
                'INSERT INTO equipes_funcoes (tenant_id, equipe_id, nome) VALUES (?, ?, ?)',
                [tenantId, req.params.id, nome]
            );
        res.json({ id: result.insertId, message: "Função criada" });
    } catch (err) {
        console.error("Erro ao criar função:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

// DELETE - Remover função
router.delete('/funcoes/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [result] = await pool.query('DELETE FROM equipes_funcoes WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: "Função não encontrada" });
        res.json({ message: "Função excluída" });
    } catch (err) {
        console.error("Erro ao deletar função:", err);
        res.status(500).json({ error: "Erro no servidor" });
    }
});

module.exports = router;
