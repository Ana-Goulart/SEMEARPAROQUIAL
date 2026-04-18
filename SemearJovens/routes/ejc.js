const express = require('express');
const router = express.Router();
const { pool, registrarLog } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');
const { ensureEjcEncontristasHistoricoTable } = require('../lib/ejcHistorySnapshots');

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function validarNumeroEjcUnico({ tenantId, numero, ejcIdIgnorar = null }) {
    const numeroNormalizado = Number(numero);
    if (!Number.isInteger(numeroNormalizado) || numeroNormalizado <= 0) {
        return 'Número do EJC inválido.';
    }

    const paramsEjc = [tenantId, numeroNormalizado];
    let sqlEjc = 'SELECT id FROM ejc WHERE tenant_id = ? AND numero = ?';
    if (ejcIdIgnorar) {
        sqlEjc += ' AND id <> ?';
        paramsEjc.push(ejcIdIgnorar);
    }
    sqlEjc += ' LIMIT 1';

    const [[ejcExistente]] = await pool.query(sqlEjc, paramsEjc);
    if (ejcExistente && ejcExistente.id) {
        return 'Já existe um EJC com esse número.';
    }

    if (await hasTable('montagens')) {
        const [montagens] = await pool.query(
            `SELECT id
             FROM montagens
             WHERE tenant_id = ?
               AND numero_ejc = ?
             LIMIT 1`,
            [tenantId, numeroNormalizado]
        );
        if (montagens && montagens.length) {
            return 'Já existe uma montagem com esse número de EJC.';
        }
    }

    return null;
}

async function runAlterIgnoreDuplicate(sql) {
    try {
        await pool.query(sql);
    } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME')) return;
        throw err;
    }
}

async function garantirEstruturaEjcDatasMontagem() {
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_encontro DATE NULL AFTER data_fim");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_tarde_revelacao DATE NULL AFTER data_encontro");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_inicio_reunioes DATE NULL AFTER data_tarde_revelacao");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN data_fim_reunioes DATE NULL AFTER data_inicio_reunioes");
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN dia_semana_reunioes TINYINT NULL AFTER data_fim_reunioes");
}

async function garantirEstruturaEjcMusicaTema() {
    await runAlterIgnoreDuplicate("ALTER TABLE ejc ADD COLUMN musica_tema VARCHAR(180) NULL AFTER descricao");
}

async function garantirRegrasPadraoParaEjc(tenantId, ejcId) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ejc_regras (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tenant_id INT NOT NULL,
            ejc_id INT NOT NULL,
            coordenador_tipo_casal VARCHAR(40) NOT NULL DEFAULT 'LIVRE',
            permite_tios_coordenadores TINYINT(1) NOT NULL DEFAULT 1,
            idade_maxima_coordenador_jovem INT NULL DEFAULT NULL,
            permite_casal_amasiado_servir TINYINT(1) NOT NULL DEFAULT 1,
            casal_amasiado_regra_equipe VARCHAR(40) NOT NULL DEFAULT 'INDIFERENTE',
            anos_casado_sem_ecc_pode_servir INT NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ejc_regras_tenant (tenant_id, ejc_id),
            KEY idx_ejc_regras_ejc (ejc_id),
            CONSTRAINT fk_ejc_regras_ejc FOREIGN KEY (ejc_id) REFERENCES ejc(id) ON DELETE CASCADE
        )
    `);

    await pool.query(
        `INSERT IGNORE INTO ejc_regras (
            tenant_id, ejc_id, coordenador_tipo_casal, permite_tios_coordenadores,
            idade_maxima_coordenador_jovem, permite_casal_amasiado_servir,
            casal_amasiado_regra_equipe, anos_casado_sem_ecc_pode_servir
        ) VALUES (?, ?, 'LIVRE', 1, NULL, 1, 'INDIFERENTE', NULL)`,
        [tenantId, ejcId]
    );
}

function normalizarData(value) {
    if (!value) return null;
    const txt = String(value).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    if (/^\d{4}-\d{2}-\d{2}T/.test(txt)) return txt.split('T')[0];
    const m = txt.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
}

// GET - Listar todos os EJCs
router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            'SELECT * FROM ejc WHERE tenant_id = ? ORDER BY numero DESC',
            [tenantId]
        );
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar EJCs:", err);
        res.status(500).json({ error: "Erro ao buscar EJCs" });
    }
});

// GET - Buscar um EJC específico
router.get('/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const [rows] = await pool.query(
            'SELECT * FROM ejc WHERE id = ? AND tenant_id = ?',
            [req.params.id, tenantId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "EJC não encontrado" });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error("Erro ao buscar EJC:", err);
        res.status(500).json({ error: "Erro ao buscar EJC" });
    }
});

// GET - Buscar encontristas de um EJC específico
router.get('/:id/encontristas', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        await ensureEjcEncontristasHistoricoTable();

        const [historicoRows] = await pool.query(`
            SELECT
                id,
                COALESCE(nome_completo_snapshot, '-') AS nome_completo,
                COALESCE(circulo_snapshot, '-') AS circulo,
                COALESCE(telefone_snapshot, '-') AS telefone,
                foi_moita,
                moita_funcao_snapshot AS moita_funcao
            FROM ejc_encontristas_historico
            WHERE tenant_id = ?
              AND ejc_id = ?
            ORDER BY nome_completo_snapshot ASC, id ASC
        `, [tenantId, req.params.id]);
        if (historicoRows.length) {
            return res.json(historicoRows);
        }

        const comOrigem = await hasColumn('jovens', 'origem_ejc_tipo');
        const comFoiMoita = await hasColumn('jovens', 'ja_foi_moita_inconfidentes');
        const comMoitaEjc = await hasColumn('jovens', 'moita_ejc_id');
        const comMoitaFuncao = await hasColumn('jovens', 'moita_funcao');

        const usarRegraMoita = comOrigem && comFoiMoita && comMoitaEjc;
        const selectFoiMoita = usarRegraMoita
            ? "CASE WHEN (j.origem_ejc_tipo = 'OUTRO_EJC' AND j.ja_foi_moita_inconfidentes = 1 AND j.moita_ejc_id = ?) THEN 1 ELSE 0 END AS foi_moita"
            : "0 AS foi_moita";
        const selectMoitaFuncao = usarRegraMoita && comMoitaFuncao
            ? "CASE WHEN (j.origem_ejc_tipo = 'OUTRO_EJC' AND j.ja_foi_moita_inconfidentes = 1 AND j.moita_ejc_id = ?) THEN j.moita_funcao ELSE NULL END AS moita_funcao"
            : "NULL AS moita_funcao";

        const sql = usarRegraMoita
            ? `SELECT DISTINCT j.id, j.nome_completo, j.circulo, j.telefone,
                      ${selectFoiMoita},
                      ${selectMoitaFuncao}
               FROM jovens j
               WHERE j.tenant_id = ?
                 AND (j.numero_ejc_fez = ?
                  OR (j.origem_ejc_tipo = 'OUTRO_EJC' AND j.ja_foi_moita_inconfidentes = 1 AND j.moita_ejc_id = ?))
               ORDER BY nome_completo ASC`
            : `SELECT j.id, j.nome_completo, j.circulo, j.telefone,
                      ${selectFoiMoita},
                      ${selectMoitaFuncao}
               FROM jovens j
               WHERE j.tenant_id = ?
                 AND j.numero_ejc_fez = ?
               ORDER BY nome_completo ASC`;
        const params = usarRegraMoita
            ? [req.params.id, req.params.id, tenantId, req.params.id, req.params.id]
            : [tenantId, req.params.id];
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar encontristas:", err);
        res.status(500).json({ error: "Erro ao buscar encontristas" });
    }
});

// POST - Criar novo EJC
router.post('/', async (req, res) => {
    const { numero, paroquia, ano, data_inicio, data_fim, data_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, descricao, musica_tema } = req.body;

    // Validação
    if (!numero || !paroquia) {
        return res.status(400).json({ error: "Número e Paróquia são obrigatórios" });
    }

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaEjcDatasMontagem();
        await garantirEstruturaEjcMusicaTema();
        const erroNumero = await validarNumeroEjcUnico({ tenantId, numero });
        if (erroNumero) {
            return res.status(400).json({ error: erroNumero });
        }
        const [result] = await pool.query(
            `INSERT INTO ejc (tenant_id, numero, paroquia, ano, data_inicio, data_fim, data_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, descricao, musica_tema)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                numero,
                paroquia,
                ano || new Date().getFullYear(),
                normalizarData(data_inicio),
                normalizarData(data_fim),
                normalizarData(data_encontro),
                normalizarData(data_tarde_revelacao),
                normalizarData(data_inicio_reunioes),
                normalizarData(data_fim_reunioes),
                descricao || null,
                musica_tema || null
            ]
        );

        // Ao criar um novo EJC, vincula automaticamente todas as equipes já cadastradas.
        await pool.query(
            `INSERT IGNORE INTO equipes_ejc (ejc_id, equipe_id)
             SELECT ?, id FROM equipes WHERE tenant_id = ?`,
            [result.insertId, tenantId]
        );

        await garantirRegrasPadraoParaEjc(tenantId, result.insertId);

        await registrarLog('sistema', 'CREATE', `EJC ${numero} criado`);

        res.status(201).json({
            message: "EJC criado com sucesso",
            id: result.insertId,
            regras_ejc_id: result.insertId
        });
    } catch (err) {
        console.error("Erro ao criar EJC:", err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "Este número de EJC já existe" });
        }
        res.status(500).json({ error: "Erro ao criar EJC" });
    }
});

// PUT - Editar EJC
router.put('/:id', async (req, res) => {
    const { numero, paroquia, ano, data_inicio, data_fim, data_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, descricao, musica_tema } = req.body;

    if (!numero || !paroquia) {
        return res.status(400).json({ error: "Número e Paróquia são obrigatórios" });
    }

    try {
        const tenantId = getTenantId(req);
        await garantirEstruturaEjcDatasMontagem();
        await garantirEstruturaEjcMusicaTema();
        const erroNumero = await validarNumeroEjcUnico({ tenantId, numero, ejcIdIgnorar: Number(req.params.id) || null });
        if (erroNumero) {
            return res.status(400).json({ error: erroNumero });
        }
        const [result] = await pool.query(
            `UPDATE ejc
             SET numero=?,
                 paroquia=?,
                 ano=?,
                 data_inicio=?,
                 data_fim=?,
                 data_encontro=?,
                 data_tarde_revelacao=?,
                 data_inicio_reunioes=?,
                 data_fim_reunioes=?,
                 descricao=?,
                 musica_tema=?
             WHERE id=? AND tenant_id = ?`,
            [
                numero,
                paroquia,
                ano,
                normalizarData(data_inicio),
                normalizarData(data_fim),
                normalizarData(data_encontro),
                normalizarData(data_tarde_revelacao),
                normalizarData(data_inicio_reunioes),
                normalizarData(data_fim_reunioes),
                descricao || null,
                musica_tema || null,
                req.params.id,
                tenantId
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "EJC não encontrado" });
        }

        await registrarLog('sistema', 'UPDATE', `EJC ${numero} atualizado`);

        res.json({ message: "EJC atualizado com sucesso" });
    } catch (err) {
        console.error("Erro ao atualizar EJC:", err);
        res.status(500).json({ error: "Erro ao atualizar EJC" });
    }
});

// DELETE - Deletar EJC
router.delete('/:id', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const ejcId = Number(req.params.id);
        if (!Number.isInteger(ejcId) || ejcId <= 0) {
            return res.status(400).json({ error: "EJC inválido" });
        }

        const [[ejcAtual]] = await pool.query(
            'SELECT id, numero FROM ejc WHERE id = ? AND tenant_id = ? LIMIT 1',
            [ejcId, tenantId]
        );
        if (!ejcAtual) {
            return res.status(404).json({ error: "EJC não encontrado" });
        }

        const hasMontagens = await hasTable('montagens');
        const hasMontagemEjcId = await hasColumn('jovens', 'montagem_ejc_id');
        const hasConjugeEjcId = await hasColumn('jovens', 'conjuge_ejc_id');
        const hasMoitaEjcId = await hasColumn('jovens', 'moita_ejc_id');
        const hasHistoricoEquipes = await hasTable('historico_equipes');
        const hasEquipesEjc = await hasTable('equipes_ejc');
        const hasTiosCasalServicos = await hasTable('tios_casal_servicos');

        let montagemDestino = null;
        if (hasMontagens && hasMontagemEjcId) {
            const [[montagem]] = await pool.query(
                `SELECT id, numero_ejc
                 FROM montagens
                 WHERE tenant_id = ?
                   AND numero_ejc = ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [tenantId, ejcAtual.numero]
            );
            montagemDestino = montagem || null;
        }

        const [jovens] = await pool.query(
            'SELECT COUNT(*) as count FROM jovens WHERE numero_ejc_fez = ? AND tenant_id = ?',
            [ejcId, tenantId]
        );

        if (jovens[0].count > 0) {
            if (montagemDestino) {
                await pool.query(
                    `UPDATE jovens
                     SET numero_ejc_fez = NULL,
                         montagem_ejc_id = ?
                     WHERE numero_ejc_fez = ?
                       AND tenant_id = ?`,
                    [montagemDestino.id, ejcId, tenantId]
                );
            } else {
                return res.status(400).json({
                    error: "Não é possível deletar este EJC. Há jovens vinculados."
                });
            }
        }

        if (hasConjugeEjcId) {
            const [conjuges] = await pool.query(
                'SELECT COUNT(*) as count FROM jovens WHERE conjuge_ejc_id = ? AND tenant_id = ?',
                [ejcId, tenantId]
            );
            if (conjuges[0].count > 0) {
                return res.status(400).json({
                    error: "Não é possível deletar este EJC. Ele está vinculado no cadastro de cônjuges."
                });
            }
        }

        if (hasMoitaEjcId) {
            const [moitas] = await pool.query(
                'SELECT COUNT(*) as count FROM jovens WHERE moita_ejc_id = ? AND tenant_id = ?',
                [ejcId, tenantId]
            );
            if (moitas[0].count > 0) {
                return res.status(400).json({
                    error: "Não é possível deletar este EJC. Ele está vinculado em registros de moita."
                });
            }
        }

        if (hasHistoricoEquipes) {
            const [historico] = await pool.query(
                'SELECT COUNT(*) as count FROM historico_equipes WHERE ejc_id = ? AND tenant_id = ?',
                [ejcId, tenantId]
            );
            if (historico[0].count > 0) {
                return res.status(400).json({
                    error: "Não é possível deletar este EJC. Ele já possui histórico de equipes."
                });
            }
        }

        if (hasEquipesEjc) {
            await pool.query(
                'DELETE FROM equipes_ejc WHERE ejc_id = ? AND tenant_id = ?',
                [ejcId, tenantId]
            );
        }

        if (hasTiosCasalServicos) {
            await pool.query(
                'DELETE FROM tios_casal_servicos WHERE ejc_id = ? AND tenant_id = ?',
                [ejcId, tenantId]
            );
        }

        const [result] = await pool.query(
            'DELETE FROM ejc WHERE id = ? AND tenant_id = ?',
            [ejcId, tenantId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "EJC não encontrado" });
        }

        await registrarLog('sistema', 'DELETE', `EJC deletado`);

        res.json({ message: "EJC deletado com sucesso" });
    } catch (err) {
        console.error("Erro ao deletar EJC:", err);
        res.status(500).json({ error: "Erro ao deletar EJC" });
    }
});

module.exports = router;
