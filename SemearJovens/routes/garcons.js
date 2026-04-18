const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

let estruturaGarantida = false;

async function garantirEstrutura() {
    if (estruturaGarantida) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS garcons_equipes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ejc_numero INT NOT NULL,
            outro_ejc_id INT NOT NULL,
            reserva_ativa TINYINT(1) NOT NULL DEFAULT 0,
            data_inicio DATE NULL,
            data_fim DATE NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_garcons_equipe_outro_ejc FOREIGN KEY (outro_ejc_id) REFERENCES outros_ejcs(id) ON DELETE RESTRICT
        )
    `);
    try {
        await pool.query('ALTER TABLE garcons_equipes ADD COLUMN reserva_ativa TINYINT(1) NOT NULL DEFAULT 0');
    } catch (e) { }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS garcons_membros (
            id INT AUTO_INCREMENT PRIMARY KEY,
            equipe_id INT NOT NULL,
            jovem_id INT NULL,
            membro_tipo VARCHAR(10) NOT NULL DEFAULT 'JOVEM',
            tio_casal_id INT NULL,
            papel VARCHAR(80) NOT NULL,
            situacao VARCHAR(20) NOT NULL DEFAULT 'TITULAR',
            comissao_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_garcons_equipe_jovem (equipe_id, jovem_id),
            CONSTRAINT fk_garcons_membro_equipe FOREIGN KEY (equipe_id) REFERENCES garcons_equipes(id) ON DELETE CASCADE,
            CONSTRAINT fk_garcons_membro_jovem FOREIGN KEY (jovem_id) REFERENCES jovens(id) ON DELETE CASCADE
        )
    `);
    try {
        await pool.query('ALTER TABLE garcons_membros MODIFY COLUMN jovem_id INT NULL');
    } catch (e) { }
    try {
        await pool.query("ALTER TABLE garcons_membros ADD COLUMN membro_tipo VARCHAR(10) NOT NULL DEFAULT 'JOVEM' AFTER jovem_id");
    } catch (e) { }
    try {
        await pool.query('ALTER TABLE garcons_membros ADD COLUMN tio_casal_id INT NULL AFTER membro_tipo');
    } catch (e) { }
    try {
        await pool.query('ALTER TABLE garcons_membros ADD COLUMN comissao_id INT NULL');
    } catch (e) { }
    try {
        await pool.query("ALTER TABLE garcons_membros ADD COLUMN situacao VARCHAR(20) NOT NULL DEFAULT 'TITULAR'");
    } catch (e) { }
    try {
        await pool.query('ALTER TABLE garcons_membros ADD UNIQUE KEY uniq_garcons_equipe_tio (equipe_id, tio_casal_id)');
    } catch (e) { }

    estruturaGarantida = true;
}

router.get('/equipes', async (req, res) => {
    try {
        await garantirEstrutura();

        const [equipes] = await pool.query(`
            SELECT ge.id, ge.ejc_numero, ge.outro_ejc_id, ge.reserva_ativa, ge.data_inicio, ge.data_fim, ge.created_at,
                   oe.nome AS outro_ejc_nome, oe.paroquia AS outro_ejc_paroquia, oe.bairro AS outro_ejc_bairro
            FROM garcons_equipes ge
            JOIN outros_ejcs oe ON oe.id = ge.outro_ejc_id
            ORDER BY ge.created_at DESC, ge.id DESC
        `);

        const [membros] = await pool.query(`
            SELECT gm.id, gm.equipe_id, gm.jovem_id, gm.membro_tipo, gm.tio_casal_id, gm.papel, gm.situacao, gm.comissao_id, gm.created_at,
                   COALESCE(
                       j.nome_completo,
                       NULLIF(
                           CONCAT(
                               COALESCE(tc.nome_tio, ''),
                               CASE
                                   WHEN COALESCE(tc.nome_tio, '') <> '' AND COALESCE(tc.nome_tia, '') <> '' THEN ' e '
                                   ELSE ''
                               END,
                               COALESCE(tc.nome_tia, '')
                           ),
                           ''
                       )
                   ) AS nome_completo,
                   COALESCE(
                       j.telefone,
                       NULLIF(
                           CONCAT(
                               COALESCE(tc.telefone_tio, ''),
                               CASE
                                   WHEN COALESCE(tc.telefone_tio, '') <> '' AND COALESCE(tc.telefone_tia, '') <> '' THEN ' / '
                                   ELSE ''
                               END,
                               COALESCE(tc.telefone_tia, '')
                           ),
                           ''
                       )
                   ) AS telefone,
                   j.circulo
            FROM garcons_membros gm
            LEFT JOIN jovens j ON j.id = gm.jovem_id
            LEFT JOIN tios_casais tc ON tc.id = gm.tio_casal_id
            ORDER BY COALESCE(j.nome_completo, tc.nome_tio, tc.nome_tia) ASC
        `);

        const mapa = new Map();
        equipes.forEach(e => mapa.set(e.id, { ...e, membros: [] }));
        membros.forEach(m => {
            const item = mapa.get(m.equipe_id);
            if (item) item.membros.push(m);
        });

        res.json(Array.from(mapa.values()));
    } catch (err) {
        console.error('Erro ao listar equipes de garçons:', err);
        res.status(500).json({ error: 'Erro ao listar equipes de garçons' });
    }
});

router.post('/equipes', async (req, res) => {
    const ejcNumero = Number(req.body.ejc_numero);
    const outroEjcId = Number(req.body.outro_ejc_id);
    const dataInicio = req.body.data_inicio ? String(req.body.data_inicio).trim() : null;
    const dataFim = req.body.data_fim ? String(req.body.data_fim).trim() : null;

    if (!Number.isInteger(ejcNumero) || ejcNumero <= 0) {
        return res.status(400).json({ error: 'Número do EJC inválido.' });
    }
    if (!Number.isInteger(outroEjcId) || outroEjcId <= 0) {
        return res.status(400).json({ error: 'Selecione o EJC da lista.' });
    }

    try {
        await garantirEstrutura();

        const [outroRows] = await pool.query('SELECT id FROM outros_ejcs WHERE id = ? LIMIT 1', [outroEjcId]);
        if (!outroRows.length) return res.status(404).json({ error: 'EJC não encontrado na lista.' });

        const [result] = await pool.query(
            `INSERT INTO garcons_equipes (ejc_numero, outro_ejc_id, data_inicio, data_fim)
             VALUES (?, ?, ?, ?)`,
            [ejcNumero, outroEjcId, dataInicio || null, dataFim || null]
        );

        res.status(201).json({ id: result.insertId, message: 'Equipe de garçons criada com sucesso' });
    } catch (err) {
        console.error('Erro ao criar equipe de garçons:', err);
        res.status(500).json({ error: 'Erro ao criar equipe de garçons' });
    }
});

router.delete('/equipes/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [membros] = await connection.query(
            'SELECT comissao_id FROM garcons_membros WHERE equipe_id = ?',
            [id]
        );
        const idsComissao = (membros || []).map(m => m.comissao_id).filter(Boolean);
        if (idsComissao.length) {
            const placeholders = idsComissao.map(() => '?').join(', ');
            await connection.query(
                `DELETE FROM jovens_comissoes WHERE id IN (${placeholders})`,
                idsComissao
            );
        }

        await connection.query('DELETE FROM garcons_equipes WHERE id = ?', [id]);
        await connection.commit();
        res.json({ message: 'Equipe removida com sucesso' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao remover equipe de garçons:', err);
        res.status(500).json({ error: 'Erro ao remover equipe de garçons' });
    } finally {
        connection.release();
    }
});

router.post('/equipes/:id/membros', async (req, res) => {
    const tenantId = getTenantId(req);
    const equipeId = Number(req.params.id);
    const membroTipo = String(req.body.membro_tipo || 'JOVEM').trim().toUpperCase() === 'TIO' ? 'TIO' : 'JOVEM';
    const jovemId = membroTipo === 'JOVEM' ? Number(req.body.jovem_id) : null;
    const tioCasalId = membroTipo === 'TIO' ? Number(req.body.tio_casal_id) : null;
    const papel = String(req.body.papel || '').trim();
    const situacaoRaw = String(req.body.situacao || 'TITULAR').trim().toUpperCase();
    const situacao = ['TITULAR', 'RESERVA'].includes(situacaoRaw) ? situacaoRaw : null;

    if (!equipeId || !papel || !situacao || (membroTipo === 'JOVEM' && !jovemId) || (membroTipo === 'TIO' && !tioCasalId)) {
        return res.status(400).json({ error: 'Dados inválidos.' });
    }

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[equipe]] = await connection.query(
            'SELECT id, ejc_numero, outro_ejc_id, reserva_ativa, data_inicio, data_fim FROM garcons_equipes WHERE id = ? LIMIT 1',
            [equipeId]
        );
        if (!equipe) {
            await connection.rollback();
            return res.status(404).json({ error: 'Equipe não encontrada.' });
        }

        if (membroTipo === 'JOVEM') {
            const [jRows] = await connection.query('SELECT id FROM jovens WHERE id = ? LIMIT 1', [jovemId]);
            if (!jRows.length) {
                await connection.rollback();
                return res.status(404).json({ error: 'Jovem não encontrado.' });
            }
        } else {
            const [tRows] = await connection.query('SELECT id FROM tios_casais WHERE id = ? AND tenant_id = ? LIMIT 1', [tioCasalId, tenantId]);
            if (!tRows.length) {
                await connection.rollback();
                return res.status(404).json({ error: 'Casal de tios não encontrado.' });
            }
        }

        const [jaExiste] = await connection.query(
            membroTipo === 'JOVEM'
                ? 'SELECT id FROM garcons_membros WHERE equipe_id = ? AND jovem_id = ? LIMIT 1'
                : 'SELECT id FROM garcons_membros WHERE equipe_id = ? AND tio_casal_id = ? LIMIT 1',
            membroTipo === 'JOVEM' ? [equipeId, jovemId] : [equipeId, tioCasalId]
        );
        if (jaExiste.length) {
            await connection.rollback();
            return res.status(409).json({ error: membroTipo === 'JOVEM' ? 'Este jovem já está na equipe.' : 'Este casal de tios já está na equipe.' });
        }

        if (situacao === 'RESERVA' && !Number(equipe.reserva_ativa)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Crie a lista de reserva desta equipe antes de adicionar jovens nela.' });
        }

        let comissaoId = null;
        if (situacao === 'TITULAR' && membroTipo === 'JOVEM') {
            const [comissaoResult] = await connection.query(
                `INSERT INTO jovens_comissoes 
                 (tenant_id, jovem_id, tipo, ejc_numero, outro_ejc_id, data_inicio, data_fim, funcao_garcom, observacao)
                 VALUES (?, ?, 'GARCOM_EQUIPE', ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    jovemId,
                    equipe.ejc_numero || null,
                    equipe.outro_ejc_id || null,
                    equipe.data_inicio || null,
                    equipe.data_fim || null,
                    papel,
                    'Equipe de Garçom'
                ]
            );
            comissaoId = comissaoResult.insertId;
        }

        await connection.query(
            'INSERT INTO garcons_membros (equipe_id, jovem_id, membro_tipo, tio_casal_id, papel, situacao, comissao_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [equipeId, jovemId, membroTipo, tioCasalId, papel, situacao, comissaoId]
        );

        await connection.commit();
        res.status(201).json({ message: membroTipo === 'JOVEM' ? 'Jovem adicionado à equipe' : 'Casal de tios adicionado à equipe' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao adicionar membro na equipe de garçons:', err);
        res.status(500).json({ error: 'Erro ao adicionar membro na equipe de garçons' });
    } finally {
        connection.release();
    }
});

router.patch('/membros/:id/situacao', async (req, res) => {
    const tenantId = getTenantId(req);
    const id = Number(req.params.id);
    const situacaoRaw = String(req.body.situacao || '').trim().toUpperCase();
    const situacao = ['TITULAR', 'RESERVA'].includes(situacaoRaw) ? situacaoRaw : null;
    if (!id || !situacao) return res.status(400).json({ error: 'Dados inválidos.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[membro]] = await connection.query(
            `SELECT gm.id, gm.equipe_id, gm.jovem_id, gm.membro_tipo, gm.tio_casal_id, gm.papel, gm.situacao, gm.comissao_id,
                    ge.ejc_numero, ge.outro_ejc_id, ge.reserva_ativa, ge.data_inicio, ge.data_fim
             FROM garcons_membros gm
             JOIN garcons_equipes ge ON ge.id = gm.equipe_id
             WHERE gm.id = ? LIMIT 1`,
            [id]
        );
        if (!membro) {
            await connection.rollback();
            return res.status(404).json({ error: 'Membro não encontrado.' });
        }

        if (membro.situacao === situacao) {
            await connection.rollback();
            return res.json({ message: 'Situação já atualizada.' });
        }

        if (situacao === 'RESERVA' && !Number(membro.reserva_ativa)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Esta equipe ainda não possui lista de reserva.' });
        }

        let novoComissaoId = membro.comissao_id || null;
        if (membro.membro_tipo === 'JOVEM' && situacao === 'TITULAR') {
            if (!membro.comissao_id) {
                const [comissaoResult] = await connection.query(
                    `INSERT INTO jovens_comissoes
                     (tenant_id, jovem_id, tipo, ejc_numero, outro_ejc_id, data_inicio, data_fim, funcao_garcom, observacao)
                     VALUES (?, ?, 'GARCOM_EQUIPE', ?, ?, ?, ?, ?, ?)`,
                    [
                        tenantId,
                        membro.jovem_id,
                        membro.ejc_numero || null,
                        membro.outro_ejc_id || null,
                        membro.data_inicio || null,
                        membro.data_fim || null,
                        membro.papel,
                        'Equipe de Garçom'
                    ]
                );
                novoComissaoId = comissaoResult.insertId;
            }
        } else if (membro.membro_tipo === 'JOVEM') {
            if (membro.comissao_id) {
                await connection.query('DELETE FROM jovens_comissoes WHERE id = ?', [membro.comissao_id]);
                novoComissaoId = null;
            }
        } else {
            novoComissaoId = null;
        }

        await connection.query(
            'UPDATE garcons_membros SET situacao = ?, comissao_id = ? WHERE id = ?',
            [situacao, novoComissaoId, id]
        );

        await connection.commit();
        res.json({ message: 'Situação atualizada com sucesso.' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao atualizar situação do membro de garçons:', err);
        res.status(500).json({ error: 'Erro ao atualizar situação do membro.' });
    } finally {
        connection.release();
    }
});

router.patch('/equipes/:id/reserva', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    try {
        await garantirEstrutura();
        const [result] = await pool.query(
            'UPDATE garcons_equipes SET reserva_ativa = 1 WHERE id = ?',
            [id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Equipe não encontrada.' });
        res.json({ message: 'Lista de reserva criada com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar lista de reserva da equipe:', err);
        res.status(500).json({ error: 'Erro ao criar lista de reserva da equipe.' });
    }
});

router.delete('/membros/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });

    const connection = await pool.getConnection();
    try {
        await garantirEstrutura();
        await connection.beginTransaction();

        const [[membro]] = await connection.query(
            'SELECT id, comissao_id FROM garcons_membros WHERE id = ? LIMIT 1',
            [id]
        );
        if (!membro) {
            await connection.rollback();
            return res.status(404).json({ error: 'Vínculo não encontrado.' });
        }

        await connection.query('DELETE FROM garcons_membros WHERE id = ?', [id]);
        if (membro.comissao_id) {
            await connection.query('DELETE FROM jovens_comissoes WHERE id = ?', [membro.comissao_id]);
        }

        await connection.commit();
        res.json({ message: 'Jovem removido da equipe' });
    } catch (err) {
        await connection.rollback();
        console.error('Erro ao remover jovem da equipe de garçons:', err);
        res.status(500).json({ error: 'Erro ao remover jovem da equipe de garçons' });
    } finally {
        connection.release();
    }
});

module.exports = router;
