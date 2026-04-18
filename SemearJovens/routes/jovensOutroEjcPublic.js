const express = require('express');
const crypto = require('crypto');
const { pool } = require('../database');

const router = express.Router();
const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_SECRET = process.env.JOVENS_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET || 'semea-jovens-public';

let estruturaOk = false;
let estruturaPromise = null;

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

async function hasTable(tableName) {
    const [rows] = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

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

async function ensureColumn(tableName, columnName, sql) {
    if (await hasColumn(tableName, columnName)) return;
    try {
        await pool.query(sql);
    } catch (err) {
        if (!err || err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
}

async function ensureEstrutura() {
    if (estruturaOk) return;
    if (estruturaPromise) return estruturaPromise;
    estruturaPromise = (async () => {
        await ensureColumn('jovens', 'apelido', 'ALTER TABLE jovens ADD COLUMN apelido VARCHAR(120) NULL AFTER nome_completo');
        await ensureColumn('jovens', 'email', 'ALTER TABLE jovens ADD COLUMN email VARCHAR(180) NULL AFTER telefone');
        await ensureColumn('jovens', 'instagram', 'ALTER TABLE jovens ADD COLUMN instagram VARCHAR(120) NULL AFTER email');
        await ensureColumn('jovens', 'termos_aceitos_em', 'ALTER TABLE jovens ADD COLUMN termos_aceitos_em DATETIME NULL AFTER instagram');
        await ensureColumn('jovens', 'termos_aceitos_email', 'ALTER TABLE jovens ADD COLUMN termos_aceitos_email VARCHAR(180) NULL AFTER termos_aceitos_em');
        await ensureColumn('jovens', 'eh_musico', 'ALTER TABLE jovens ADD COLUMN eh_musico TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao');

        if (!await hasTable('tios_casais')) {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS tios_casais (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    tenant_id INT NOT NULL,
                    ecc_id INT NULL,
                    origem_tipo ENUM('EJC','OUTRO_EJC') NOT NULL DEFAULT 'EJC',
                    outro_ejc_id INT NULL,
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
                    termos_aceitos_em DATETIME NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    KEY idx_tios_casais_tenant (tenant_id),
                    KEY idx_tios_casais_ecc (ecc_id),
                    KEY idx_tios_casais_outro (outro_ejc_id)
                )
            `);
        }

        const colunasTios = [
            ['origem_tipo', "ALTER TABLE tios_casais ADD COLUMN origem_tipo ENUM('EJC','OUTRO_EJC') NOT NULL DEFAULT 'EJC' AFTER ecc_id"],
            ['outro_ejc_id', 'ALTER TABLE tios_casais ADD COLUMN outro_ejc_id INT NULL AFTER origem_tipo'],
            ['restricao_alimentar', 'ALTER TABLE tios_casais ADD COLUMN restricao_alimentar TINYINT(1) NOT NULL DEFAULT 0 AFTER data_nascimento_tia'],
            ['deficiencia', 'ALTER TABLE tios_casais ADD COLUMN deficiencia TINYINT(1) NOT NULL DEFAULT 0 AFTER restricao_alimentar'],
            ['restricao_alimentar_tio', 'ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER deficiencia'],
            ['detalhes_restricao_tio', 'ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tio VARCHAR(255) NULL AFTER restricao_alimentar_tio'],
            ['deficiencia_tio', 'ALTER TABLE tios_casais ADD COLUMN deficiencia_tio TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tio'],
            ['qual_deficiencia_tio', 'ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tio VARCHAR(255) NULL AFTER deficiencia_tio'],
            ['restricao_alimentar_tia', 'ALTER TABLE tios_casais ADD COLUMN restricao_alimentar_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER qual_deficiencia_tio'],
            ['detalhes_restricao_tia', 'ALTER TABLE tios_casais ADD COLUMN detalhes_restricao_tia VARCHAR(255) NULL AFTER restricao_alimentar_tia'],
            ['deficiencia_tia', 'ALTER TABLE tios_casais ADD COLUMN deficiencia_tia TINYINT(1) NOT NULL DEFAULT 0 AFTER detalhes_restricao_tia'],
            ['qual_deficiencia_tia', 'ALTER TABLE tios_casais ADD COLUMN qual_deficiencia_tia VARCHAR(255) NULL AFTER deficiencia_tia'],
            ['termos_aceitos_em', 'ALTER TABLE tios_casais ADD COLUMN termos_aceitos_em DATETIME NULL AFTER observacoes']
        ];
        for (const [columnName, sql] of colunasTios) {
            // eslint-disable-next-line no-await-in-loop
            await ensureColumn('tios_casais', columnName, sql);
        }

        estruturaOk = true;
    })();

    try {
        await estruturaPromise;
    } finally {
        estruturaPromise = null;
    }
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
        if (!payload || !payload.tipo || !payload.cadastro_id || !payload.tenant_id || !payload.ts) return null;
        if ((Date.now() - Number(payload.ts)) > TOKEN_TTL_MS) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

async function tenantIdPorOutroEjc(outroEjcId) {
    if (!outroEjcId) return null;
    const [rows] = await pool.query(
        'SELECT tenant_id FROM outros_ejcs WHERE id = ? LIMIT 1',
        [outroEjcId]
    );
    return rows && rows[0] ? rows[0].tenant_id : null;
}

router.get('/outros-ejcs', async (_req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, nome, paroquia FROM outros_ejcs ORDER BY paroquia ASC, nome ASC'
        );
        return res.json(rows || []);
    } catch (err) {
        console.error('Erro ao listar outros EJCs (público):', err);
        return res.status(500).json({ error: 'Erro ao listar paróquias.' });
    }
});

router.get('/membros', async (req, res) => {
    try {
        await ensureEstrutura();
        const outroEjcId = Number(req.query.outro_ejc_id || 0);
        const tipo = String(req.query.tipo || '').trim().toLowerCase();
        if (!outroEjcId || !['jovem', 'tio'].includes(tipo)) {
            return res.status(400).json({ error: 'Selecione a paróquia e o tipo de cadastro.' });
        }

        if (tipo === 'jovem') {
            const [rows] = await pool.query(`
                SELECT id, nome_completo
                FROM jovens
                WHERE origem_ejc_tipo = 'OUTRO_EJC'
                  AND outro_ejc_id = ?
                  AND COALESCE(transferencia_outro_ejc, 0) = 0
                ORDER BY nome_completo ASC
            `, [outroEjcId]);
            return res.json((rows || []).map((row) => ({
                id: row.id,
                nome: row.nome_completo || 'Sem nome'
            })));
        }

        const [rows] = await pool.query(`
            SELECT id, nome_tio, nome_tia
            FROM tios_casais
            WHERE origem_tipo = 'OUTRO_EJC'
              AND outro_ejc_id = ?
            ORDER BY nome_tio ASC, nome_tia ASC
        `, [outroEjcId]);
        return res.json((rows || []).map((row) => ({
            id: row.id,
            nome_tio: row.nome_tio || '',
            nome_tia: row.nome_tia || '',
            nome: [row.nome_tio, row.nome_tia].filter(Boolean).join(' e ')
        })));
    } catch (err) {
        console.error('Erro ao listar membros de outro EJC (público):', err);
        return res.status(500).json({ error: 'Erro ao listar os cadastros.' });
    }
});

router.post('/validar-jovem', async (req, res) => {
    try {
        await ensureEstrutura();
        const jovemId = Number(req.body.jovem_id || 0);
        const outroEjcId = Number(req.body.outro_ejc_id || 0);
        const telefone = String(req.body.telefone || '').trim();
        const dataNascimento = normalizeDate(req.body.data_nascimento);

        if (!jovemId || !outroEjcId || !telefone || !dataNascimento) {
            return res.status(400).json({ error: 'Selecione o jovem e confirme telefone e data de nascimento.' });
        }

        const [rows] = await pool.query(`
            SELECT id, tenant_id, nome_completo, telefone, data_nascimento, apelido, email, instagram,
                   estado_civil, sexo, circulo, deficiencia, qual_deficiencia, restricao_alimentar,
                   detalhes_restricao, ${await hasColumn('jovens', 'eh_musico') ? 'eh_musico' : '0 AS eh_musico'},
                   termos_aceitos_em, termos_aceitos_email
            FROM jovens
            WHERE id = ?
              AND origem_ejc_tipo = 'OUTRO_EJC'
              AND outro_ejc_id = ?
              AND COALESCE(transferencia_outro_ejc, 0) = 0
            LIMIT 1
        `, [jovemId, outroEjcId]);

        if (!rows.length) {
            return res.status(404).json({ error: 'Cadastro não encontrado nessa paróquia.' });
        }

        const jovem = rows[0];
        if (normalizePhoneDigits(jovem.telefone) !== normalizePhoneDigits(telefone) || normalizeDate(jovem.data_nascimento) !== dataNascimento) {
            return res.status(400).json({ error: 'Telefone ou data de nascimento não conferem com o cadastro.' });
        }

        const token = criarToken({
            tipo: 'JOVEM',
            cadastro_id: jovem.id,
            tenant_id: jovem.tenant_id,
            ts: Date.now()
        });

        return res.json({
            message: 'Dados confirmados. Agora você pode atualizar o cadastro.',
            token,
            cadastro: {
                nome: jovem.nome_completo || '',
                telefone: jovem.telefone || '',
                apelido: jovem.apelido || '',
                email: jovem.email || '',
                instagram: jovem.instagram || '',
                estado_civil: jovem.estado_civil || '',
                sexo: jovem.sexo || '',
                circulo: jovem.circulo || '',
                deficiencia: !!jovem.deficiencia,
                qual_deficiencia: jovem.qual_deficiencia || '',
                restricao_alimentar: !!jovem.restricao_alimentar,
                detalhes_restricao: jovem.detalhes_restricao || '',
                eh_musico: !!jovem.eh_musico,
                termos_aceitos_em: jovem.termos_aceitos_em || null,
                termos_aceitos_email: jovem.termos_aceitos_email || null
            }
        });
    } catch (err) {
        console.error('Erro ao validar jovem de outro EJC (público):', err);
        return res.status(500).json({ error: 'Erro ao validar cadastro.' });
    }
});

router.post('/atualizar-jovem', async (req, res) => {
    try {
        await ensureEstrutura();
        const payload = validarToken(String(req.body.token || '').trim());
        if (!payload || payload.tipo !== 'JOVEM') {
            return res.status(401).json({ error: 'Validação expirada ou inválida.' });
        }
        if (!parseBool(req.body.aceite_termos)) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }

        const telefone = String(req.body.telefone || '').trim();
        const apelido = String(req.body.apelido || '').trim() || null;
        const email = String(req.body.email || '').trim() || null;
        const instagram = String(req.body.instagram || '').trim() || null;
        const estadoCivil = String(req.body.estado_civil || '').trim() || null;
        const sexo = String(req.body.sexo || '').trim() || null;
        const circulo = String(req.body.circulo || '').trim() || null;
        const deficiencia = parseBool(req.body.deficiencia);
        const qualDeficiencia = deficiencia ? (String(req.body.qual_deficiencia || '').trim() || null) : null;
        const restricaoAlimentar = parseBool(req.body.restricao_alimentar);
        const detalhesRestricao = restricaoAlimentar ? (String(req.body.detalhes_restricao || '').trim() || null) : null;
        const ehMusico = parseBool(req.body.eh_musico);

        if (!telefone) return res.status(400).json({ error: 'Informe o telefone.' });
        if (deficiencia && !qualDeficiencia) return res.status(400).json({ error: 'Informe qual deficiência.' });
        if (restricaoAlimentar && !detalhesRestricao) return res.status(400).json({ error: 'Informe a restrição alimentar.' });

        const campos = [
            'telefone = ?',
            'apelido = ?',
            'email = ?',
            'instagram = ?',
            'estado_civil = ?',
            'sexo = ?',
            'circulo = ?',
            'deficiencia = ?',
            'qual_deficiencia = ?',
            'restricao_alimentar = ?',
            'detalhes_restricao = ?',
            'termos_aceitos_em = CURRENT_TIMESTAMP',
            'termos_aceitos_email = ?'
        ];
        const params = [
            telefone,
            apelido,
            email,
            instagram,
            estadoCivil,
            sexo,
            circulo,
            deficiencia ? 1 : 0,
            qualDeficiencia,
            restricaoAlimentar ? 1 : 0,
            detalhesRestricao,
            email
        ];
        if (await hasColumn('jovens', 'eh_musico')) {
            campos.push('eh_musico = ?');
            params.push(ehMusico ? 1 : 0);
        }
        params.push(payload.cadastro_id, payload.tenant_id);

        const [result] = await pool.query(
            `UPDATE jovens
             SET ${campos.join(', ')}
             WHERE id = ?
               AND tenant_id = ?
               AND origem_ejc_tipo = 'OUTRO_EJC'`,
            params
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }
        return res.json({ message: 'Dados atualizados com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar jovem de outro EJC (público):', err);
        return res.status(500).json({ error: 'Erro ao atualizar cadastro.' });
    }
});

router.post('/validar-tio', async (req, res) => {
    try {
        await ensureEstrutura();
        const casalId = Number(req.body.casal_id || 0);
        const outroEjcId = Number(req.body.outro_ejc_id || 0);
        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const dataTio = normalizeDate(req.body.data_nascimento_tio);
        const dataTia = normalizeDate(req.body.data_nascimento_tia);

        if (!casalId || !outroEjcId || !telefoneTio || !telefoneTia || !dataTio || !dataTia) {
            return res.status(400).json({ error: 'Selecione o casal e confirme os telefones e datas de nascimento.' });
        }

        const [rows] = await pool.query(`
            SELECT id, tenant_id, nome_tio, telefone_tio, data_nascimento_tio,
                   nome_tia, telefone_tia, data_nascimento_tia,
                   restricao_alimentar_tio, detalhes_restricao_tio,
                   deficiencia_tio, qual_deficiencia_tio,
                   restricao_alimentar_tia, detalhes_restricao_tia,
                   deficiencia_tia, qual_deficiencia_tia,
                   termos_aceitos_em
            FROM tios_casais
            WHERE id = ?
              AND origem_tipo = 'OUTRO_EJC'
              AND outro_ejc_id = ?
            LIMIT 1
        `, [casalId, outroEjcId]);

        if (!rows.length) {
            return res.status(404).json({ error: 'Cadastro não encontrado nessa paróquia.' });
        }

        const casal = rows[0];
        const okTio = normalizePhoneDigits(casal.telefone_tio) === normalizePhoneDigits(telefoneTio) && normalizeDate(casal.data_nascimento_tio) === dataTio;
        const okTia = normalizePhoneDigits(casal.telefone_tia) === normalizePhoneDigits(telefoneTia) && normalizeDate(casal.data_nascimento_tia) === dataTia;
        if (!okTio || !okTia) {
            return res.status(400).json({ error: 'Os dados do tio ou da tia não conferem com o cadastro.' });
        }

        const token = criarToken({
            tipo: 'TIO',
            cadastro_id: casal.id,
            tenant_id: casal.tenant_id,
            ts: Date.now()
        });

        return res.json({
            message: 'Dados confirmados. Agora você pode atualizar o cadastro.',
            token,
            cadastro: {
                nome_tio: casal.nome_tio || '',
                telefone_tio: casal.telefone_tio || '',
                nome_tia: casal.nome_tia || '',
                telefone_tia: casal.telefone_tia || '',
                restricao_alimentar_tio: !!casal.restricao_alimentar_tio,
                detalhes_restricao_tio: casal.detalhes_restricao_tio || '',
                deficiencia_tio: !!casal.deficiencia_tio,
                qual_deficiencia_tio: casal.qual_deficiencia_tio || '',
                restricao_alimentar_tia: !!casal.restricao_alimentar_tia,
                detalhes_restricao_tia: casal.detalhes_restricao_tia || '',
                deficiencia_tia: !!casal.deficiencia_tia,
                qual_deficiencia_tia: casal.qual_deficiencia_tia || '',
                termos_aceitos_em: casal.termos_aceitos_em || null
            }
        });
    } catch (err) {
        console.error('Erro ao validar casal de outro EJC (público):', err);
        return res.status(500).json({ error: 'Erro ao validar cadastro.' });
    }
});

router.post('/atualizar-tio', async (req, res) => {
    try {
        await ensureEstrutura();
        const payload = validarToken(String(req.body.token || '').trim());
        if (!payload || payload.tipo !== 'TIO') {
            return res.status(401).json({ error: 'Validação expirada ou inválida.' });
        }
        if (!parseBool(req.body.aceite_termos)) {
            return res.status(400).json({ error: 'É necessário aceitar os termos de uso.' });
        }

        const telefoneTio = String(req.body.telefone_tio || '').trim();
        const telefoneTia = String(req.body.telefone_tia || '').trim();
        const restricaoAlimentarTio = parseBool(req.body.restricao_alimentar_tio);
        const detalhesRestricaoTio = restricaoAlimentarTio ? (String(req.body.detalhes_restricao_tio || '').trim() || null) : null;
        const deficienciaTio = parseBool(req.body.deficiencia_tio);
        const qualDeficienciaTio = deficienciaTio ? (String(req.body.qual_deficiencia_tio || '').trim() || null) : null;
        const restricaoAlimentarTia = parseBool(req.body.restricao_alimentar_tia);
        const detalhesRestricaoTia = restricaoAlimentarTia ? (String(req.body.detalhes_restricao_tia || '').trim() || null) : null;
        const deficienciaTia = parseBool(req.body.deficiencia_tia);
        const qualDeficienciaTia = deficienciaTia ? (String(req.body.qual_deficiencia_tia || '').trim() || null) : null;

        if (!telefoneTio || !telefoneTia) {
            return res.status(400).json({ error: 'Informe os telefones do tio e da tia.' });
        }
        if (restricaoAlimentarTio && !detalhesRestricaoTio) {
            return res.status(400).json({ error: 'Informe a restrição alimentar do tio.' });
        }
        if (restricaoAlimentarTia && !detalhesRestricaoTia) {
            return res.status(400).json({ error: 'Informe a restrição alimentar da tia.' });
        }
        if (deficienciaTio && !qualDeficienciaTio) {
            return res.status(400).json({ error: 'Informe a deficiência do tio.' });
        }
        if (deficienciaTia && !qualDeficienciaTia) {
            return res.status(400).json({ error: 'Informe a deficiência da tia.' });
        }

        const [result] = await pool.query(`
            UPDATE tios_casais
               SET telefone_tio = ?,
                   telefone_tia = ?,
                   restricao_alimentar = ?,
                   deficiencia = ?,
                   restricao_alimentar_tio = ?,
                   detalhes_restricao_tio = ?,
                   deficiencia_tio = ?,
                   qual_deficiencia_tio = ?,
                   restricao_alimentar_tia = ?,
                   detalhes_restricao_tia = ?,
                   deficiencia_tia = ?,
                   qual_deficiencia_tia = ?,
                   termos_aceitos_em = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND tenant_id = ?
               AND origem_tipo = 'OUTRO_EJC'
        `, [
            telefoneTio,
            telefoneTia,
            (restricaoAlimentarTio || restricaoAlimentarTia) ? 1 : 0,
            (deficienciaTio || deficienciaTia) ? 1 : 0,
            restricaoAlimentarTio ? 1 : 0,
            detalhesRestricaoTio,
            deficienciaTio ? 1 : 0,
            qualDeficienciaTio,
            restricaoAlimentarTia ? 1 : 0,
            detalhesRestricaoTia,
            deficienciaTia ? 1 : 0,
            qualDeficienciaTia,
            payload.cadastro_id,
            payload.tenant_id
        ]);

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Cadastro não encontrado.' });
        }
        return res.json({ message: 'Dados atualizados com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar casal de outro EJC (público):', err);
        return res.status(500).json({ error: 'Erro ao atualizar cadastro.' });
    }
});

module.exports = router;
