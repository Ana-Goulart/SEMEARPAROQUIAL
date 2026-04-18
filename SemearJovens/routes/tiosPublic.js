const express = require('express');
const crypto = require('crypto');
const { pool } = require('../database');

const router = express.Router();
const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_SECRET = process.env.JOVENS_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET || 'semea-jovens-public';

let estruturaOk = false;
let estruturaPromise = null;

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

async function ensureEstrutura() {
    if (estruturaOk) return;
    if (estruturaPromise) return estruturaPromise;
    estruturaPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_ecc (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                numero VARCHAR(30) NOT NULL,
                tipo VARCHAR(10) NOT NULL DEFAULT 'ECC',
                descricao VARCHAR(160) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_tios_ecc_tenant_numero (tenant_id, numero)
            )
        `);
        const temTipo = await hasColumn('tios_ecc', 'tipo');
        if (!temTipo) {
            await pool.query("ALTER TABLE tios_ecc ADD COLUMN tipo VARCHAR(10) NOT NULL DEFAULT 'ECC' AFTER numero");
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS tios_casais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id INT NOT NULL,
                ecc_id INT NULL,
                nome_tio VARCHAR(180) NOT NULL,
                telefone_tio VARCHAR(30) NOT NULL,
                data_nascimento_tio DATE NULL,
                nome_tia VARCHAR(180) NOT NULL,
                telefone_tia VARCHAR(30) NOT NULL,
                data_nascimento_tia DATE NULL,
                restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0,
                deficiencia TINYINT(1) NOT NULL DEFAULT 0,
                restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0,
                detalhes_restricao_tio VARCHAR(255) NULL,
                deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0,
                qual_deficiencia_tio VARCHAR(255) NULL,
                restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0,
                detalhes_restricao_tia VARCHAR(255) NULL,
                deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0,
                qual_deficiencia_tia VARCHAR(255) NULL,
                observacoes VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_tios_casais_tenant (tenant_id),
                KEY idx_tios_casais_ecc (ecc_id)
            )
        `);
        const temRestricaoAlimentar = await hasColumn('tios_casais', 'restricao_alimentar');
        if (!temRestricaoAlimentar) {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tia");
        }
        const temDeficiencia = await hasColumn('tios_casais', 'deficiencia');
        if (!temDeficiencia) {
            await pool.query("ALTER TABLE tios_casais ADD COLUMN deficiencia TINYINT(1) NOT NULL DEFAULT 0 AFTER restricao_alimentar");
        }
        const colunasExtras = [
            ["restricao_alimentar_tio", "ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER deficiencia"],
            ["detalhes_restricao_tio", "ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tio VARCHAR(255) NULL AFTER restricao_alimentar_tio"],
            ["deficiencia_tio", "ALTER TABLE tios_casais ADD COLUMN deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tio"],
            ["qual_deficiencia_tio", "ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tio VARCHAR(255) NULL AFTER deficiencia_tio"],
            ["restricao_alimentar_tia", "ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tio"],
            ["detalhes_restricao_tia", "ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tia VARCHAR(255) NULL AFTER restricao_alimentar_tia"],
            ["deficiencia_tia", "ALTER TABLE tios_casais ADD COLUMN deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tia"],
            ["qual_deficiencia_tia", "ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tia VARCHAR(255) NULL AFTER deficiencia_tia"],
            ["termos_aceitos_em", "ALTER TABLE tios_casais ADD COLUMN termos_aceitos_em DATETIME NULL AFTER observacoes"]
        ];
        for (const [coluna, sql] of colunasExtras) {
            // eslint-disable-next-line no-await-in-loop
            if (!await hasColumn('tios_casais', coluna)) await pool.query(sql);
        }
        await pool.query(`
            UPDATE tios_casais
               SET restricao_alimentar_tio = CASE WHEN restricao_alimentar = 1 THEN 1 ELSE restricao_alimentar_tio END,
                   restricao_alimentar_tia = CASE WHEN restricao_alimentar = 1 THEN 1 ELSE restricao_alimentar_tia END,
                   deficiencia_tio = CASE WHEN deficiencia = 1 THEN 1 ELSE deficiencia_tio END,
                   deficiencia_tia = CASE WHEN deficiencia = 1 THEN 1 ELSE deficiencia_tia END
        `);

        estruturaOk = true;
    })();

    try {
        await estruturaPromise;
    } finally {
        estruturaPromise = null;
    }
}

function normalizeDate(v) {
    if (!v) return null;
    const txt = String(v).trim();
    if (!txt) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return txt;
    const br = txt.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    if (txt.includes('T')) return txt.split('T')[0];
    return null;
}

function normalizePhoneDigits(v) {
    return String(v || '').replace(/\D/g, '');
}

function parseBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    const txt = String(v || '').trim().toLowerCase();
    return txt === '1' || txt === 'true' || txt === 'sim' || txt === 'yes';
}

function criarToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function validarToken(token) {
    try {
        if (!token || typeof token !== 'string' || !token.includes('.')) return null;
        const [body, sig] = token.split('.');
        const sigEsperada = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
        if (sig !== sigEsperada) return null;
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || !payload.casal_id || !payload.tenant_id || !payload.ts) return null;
        if ((Date.now() - Number(payload.ts)) > TOKEN_TTL_MS) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

router.get('/ecc', async (_req, res) => {
    try {
        await ensureEstrutura();
        const [rows] = await pool.query(
            'SELECT id, numero, tipo, descricao FROM tios_ecc ORDER BY numero ASC'
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar ECC (público):', err);
        return res.status(500).json({ error: 'Erro ao listar ECC.' });
    }
});

router.post('/validar', async (req, res) => {
    try {
        await ensureEstrutura();
        const nomeTio = String(req.body.nome_tio || '').trim();
        const nomeTia = String(req.body.nome_tia || '').trim();
        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const dataTio = normalizeDate(req.body.data_nascimento_tio);
        const dataTia = normalizeDate(req.body.data_nascimento_tia);
        const eccId = Number(req.body.ecc_id || 0);

        if (!nomeTio || !nomeTia || !telefoneTio || !telefoneTia || !dataTio || !dataTia || !eccId) {
            return res.status(400).json({ error: 'Preencha nome, telefone, datas de nascimento e o ECC.' });
        }

        const telTioDigits = normalizePhoneDigits(telefoneTio);
        const telTiaDigits = normalizePhoneDigits(telefoneTia);
        if (!telTioDigits || !telTiaDigits) {
            return res.status(400).json({ error: 'Telefone inválido.' });
        }

        const [rows] = await pool.query(
            `SELECT id, tenant_id, telefone_tio, telefone_tia, restricao_alimentar, deficiencia,
                    restricao_alimentar_tio, detalhes_restricao_tio, deficiencia_tio, qual_deficiencia_tio,
                    restricao_alimentar_tia, detalhes_restricao_tia, deficiencia_tia, qual_deficiencia_tia
             FROM tios_casais
             WHERE ecc_id = ?
               AND LOWER(TRIM(nome_tio)) = LOWER(TRIM(?))
               AND LOWER(TRIM(nome_tia)) = LOWER(TRIM(?))
               AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone_tio, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
               AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(telefone_tia, '')), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') = ?
               AND DATE(data_nascimento_tio) = ?
               AND DATE(data_nascimento_tia) = ?`,
            [eccId, nomeTio, nomeTia, telTioDigits, telTiaDigits, dataTio, dataTia]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Não encontramos cadastro com esses dados.' });
        }
        if (rows.length > 1) {
            return res.status(409).json({ error: 'Encontramos mais de um cadastro. Procure a coordenação.' });
        }

        const token = criarToken({
            casal_id: rows[0].id,
            tenant_id: rows[0].tenant_id,
            ts: Date.now()
        });

        return res.json({
            message: 'Cadastro confirmado. Agora você pode atualizar os dados.',
            token,
            casal: {
                telefone_tio: rows[0].telefone_tio || '',
                telefone_tia: rows[0].telefone_tia || '',
                restricao_alimentar: !!rows[0].restricao_alimentar,
                deficiencia: !!rows[0].deficiencia,
                restricao_alimentar_tio: !!rows[0].restricao_alimentar_tio,
                detalhes_restricao_tio: rows[0].detalhes_restricao_tio || '',
                deficiencia_tio: !!rows[0].deficiencia_tio,
                qual_deficiencia_tio: rows[0].qual_deficiencia_tio || '',
                restricao_alimentar_tia: !!rows[0].restricao_alimentar_tia,
                detalhes_restricao_tia: rows[0].detalhes_restricao_tia || '',
                deficiencia_tia: !!rows[0].deficiencia_tia,
                qual_deficiencia_tia: rows[0].qual_deficiencia_tia || ''
            }
        });
    } catch (err) {
        console.error('Erro ao validar dados de tios (público):', err);
        return res.status(500).json({ error: 'Erro ao validar dados.' });
    }
});

router.post('/atualizar', async (req, res) => {
    try {
        await ensureEstrutura();
        const token = String(req.body.token || '').trim();
        const payload = validarToken(token);
        if (!payload) return res.status(401).json({ error: 'Validação expirada ou inválida.' });

        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const aceiteTermos = parseBool(req.body.aceite_termos);
        const restricaoAlimentarTio = req.body.restricao_alimentar_tio !== undefined ? parseBool(req.body.restricao_alimentar_tio) : parseBool(req.body.restricao_alimentar);
        const detalhesRestricaoTio = restricaoAlimentarTio ? (String(req.body.detalhes_restricao_tio || '').trim() || null) : null;
        const deficienciaTio = req.body.deficiencia_tio !== undefined ? parseBool(req.body.deficiencia_tio) : parseBool(req.body.deficiencia);
        const qualDeficienciaTio = deficienciaTio ? (String(req.body.qual_deficiencia_tio || '').trim() || null) : null;
        const restricaoAlimentarTia = req.body.restricao_alimentar_tia !== undefined ? parseBool(req.body.restricao_alimentar_tia) : parseBool(req.body.restricao_alimentar);
        const detalhesRestricaoTia = restricaoAlimentarTia ? (String(req.body.detalhes_restricao_tia || '').trim() || null) : null;
        const deficienciaTia = req.body.deficiencia_tia !== undefined ? parseBool(req.body.deficiencia_tia) : parseBool(req.body.deficiencia);
        const qualDeficienciaTia = deficienciaTia ? (String(req.body.qual_deficiencia_tia || '').trim() || null) : null;
        const restricaoAlimentar = restricaoAlimentarTio || restricaoAlimentarTia;
        const deficiencia = deficienciaTio || deficienciaTia;
        const observacoesAdicionais = String(req.body.observacoes_adicionais || '').trim() || null;
        if (!aceiteTermos) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }
        if (!telefoneTio || !telefoneTia) {
            return res.status(400).json({ error: 'Informe o telefone do tio e da tia.' });
        }

        const [result] = await pool.query(
            `UPDATE tios_casais
             SET telefone_tio = ?, telefone_tia = ?, restricao_alimentar = ?, deficiencia = ?,
                 restricao_alimentar_tio = ?, detalhes_restricao_tio = ?, deficiencia_tio = ?, qual_deficiencia_tio = ?,
                 restricao_alimentar_tia = ?, detalhes_restricao_tia = ?, deficiencia_tia = ?, qual_deficiencia_tia = ?,
                 observacoes = COALESCE(?, observacoes), termos_aceitos_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND tenant_id = ?`,
            [
                telefoneTio, telefoneTia, restricaoAlimentar ? 1 : 0, deficiencia ? 1 : 0,
                restricaoAlimentarTio ? 1 : 0, detalhesRestricaoTio, deficienciaTio ? 1 : 0, qualDeficienciaTio,
                restricaoAlimentarTia ? 1 : 0, detalhesRestricaoTia, deficienciaTia ? 1 : 0, qualDeficienciaTia,
                observacoesAdicionais, payload.casal_id, payload.tenant_id
            ]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }

        return res.json({ message: 'Dados atualizados com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar dados de tios (público):', err);
        return res.status(500).json({ error: 'Erro ao atualizar dados.' });
    }
});

router.post('/criar', async (req, res) => {
    try {
        await ensureEstrutura();
        const nomeTio = String(req.body.nome_tio || '').trim();
        const nomeTia = String(req.body.nome_tia || '').trim();
        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const dataTio = normalizeDate(req.body.data_nascimento_tio);
        const dataTia = normalizeDate(req.body.data_nascimento_tia);
        const eccId = Number(req.body.ecc_id || 0);
        const aceiteTermos = parseBool(req.body.aceite_termos);
        const restricaoAlimentarTio = req.body.restricao_alimentar_tio !== undefined ? parseBool(req.body.restricao_alimentar_tio) : parseBool(req.body.restricao_alimentar);
        const detalhesRestricaoTio = restricaoAlimentarTio ? (String(req.body.detalhes_restricao_tio || '').trim() || null) : null;
        const deficienciaTio = req.body.deficiencia_tio !== undefined ? parseBool(req.body.deficiencia_tio) : parseBool(req.body.deficiencia);
        const qualDeficienciaTio = deficienciaTio ? (String(req.body.qual_deficiencia_tio || '').trim() || null) : null;
        const restricaoAlimentarTia = req.body.restricao_alimentar_tia !== undefined ? parseBool(req.body.restricao_alimentar_tia) : parseBool(req.body.restricao_alimentar);
        const detalhesRestricaoTia = restricaoAlimentarTia ? (String(req.body.detalhes_restricao_tia || '').trim() || null) : null;
        const deficienciaTia = req.body.deficiencia_tia !== undefined ? parseBool(req.body.deficiencia_tia) : parseBool(req.body.deficiencia);
        const qualDeficienciaTia = deficienciaTia ? (String(req.body.qual_deficiencia_tia || '').trim() || null) : null;
        const restricaoAlimentar = restricaoAlimentarTio || restricaoAlimentarTia;
        const deficiencia = deficienciaTio || deficienciaTia;
        const observacoes = String(req.body.observacoes || '').trim() || null;

        if (!nomeTio || !nomeTia || !telefoneTio || !telefoneTia || !dataTio || !dataTia || !eccId) {
            return res.status(400).json({ error: 'Preencha nome, telefone, datas de nascimento e o ECC/ECNA.' });
        }
        if (!aceiteTermos) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }

        const [eccRows] = await pool.query(
            'SELECT id, tenant_id FROM tios_ecc WHERE id = ? LIMIT 1',
            [eccId]
        );
        if (!eccRows.length) return res.status(400).json({ error: 'Encontro inválido.' });

        const tenantId = eccRows[0].tenant_id;
        const [result] = await pool.query(
            `INSERT INTO tios_casais
             (tenant_id, ecc_id, nome_tio, telefone_tio, data_nascimento_tio, nome_tia, telefone_tia, data_nascimento_tia,
              restricao_alimentar, deficiencia,
              restricao_alimentar_tio, detalhes_restricao_tio, deficiencia_tio, qual_deficiencia_tio,
              restricao_alimentar_tia, detalhes_restricao_tia, deficiencia_tia, qual_deficiencia_tia, observacoes, termos_aceitos_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                eccId,
                nomeTio,
                telefoneTio,
                dataTio,
                nomeTia,
                telefoneTia,
                dataTia,
                restricaoAlimentar ? 1 : 0,
                deficiencia ? 1 : 0,
                restricaoAlimentarTio ? 1 : 0,
                detalhesRestricaoTio,
                deficienciaTio ? 1 : 0,
                qualDeficienciaTio,
                restricaoAlimentarTia ? 1 : 0,
                detalhesRestricaoTia,
                deficienciaTia ? 1 : 0,
                qualDeficienciaTia,
                observacoes,
                new Date()
            ]
        );

        return res.status(201).json({ id: result.insertId, message: 'Cadastro criado com sucesso.' });
    } catch (err) {
        console.error('Erro ao criar cadastro de tios (público):', err);
        return res.status(500).json({ error: 'Erro ao criar cadastro.' });
    }
});

module.exports = router;
